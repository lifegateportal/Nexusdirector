"""
Nexus Director — Voice Cloning Worker
RunPod Serverless handler using Coqui XTTS v2 (open-source ElevenLabs-quality TTS).

Actions:
  clone      — Upload a voice sample → returns a stable voice_id (R2 key of the WAV)
  synthesize — Text + voice_id → returns base64 WAV audio

Deploy:
  docker build -t nexus-voice-worker .
  docker push <your-registry>/nexus-voice-worker:latest
  Create a RunPod Serverless endpoint pointing at this image.
"""

import runpod
import base64
import os
import io
import re
import sys
import tempfile
import logging
import urllib.request
from urllib.parse import urlparse
import builtins
import boto3
from contextlib import contextmanager
from pathlib import Path

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("nexus-voice")

# RunPod workers are non-interactive. Some upstream libs may attempt stdin prompts
# (license confirmations, model-download questions). Force deterministic "yes"
# responses process-wide so jobs never fail with EOF on input().
os.environ["COQUI_TOS_AGREED"] = "1"
builtins.input = lambda _prompt="": "y"

# ── Lazy model loader ──────────────────────────────────────────────────────────
# XTTS v2 takes ~10–20 s to load on first request (cold start).
# Subsequent requests on the same worker are fast (~2–5 s per paragraph).

_tts = None


@contextmanager
def auto_accept_input():
    """Force non-interactive yes responses for model/license prompts."""
    original_input = builtins.input
    original_stdin = sys.stdin
    builtins.input = lambda _prompt="": "y"
    # Some libraries read directly from stdin instead of calling input().
    # Provide an endless stream of "y" answers to avoid EOF in headless workers.
    sys.stdin = io.StringIO("y\n" * 256)
    try:
        yield
    finally:
        builtins.input = original_input
        sys.stdin = original_stdin

def get_tts():
    global _tts
    if _tts is None:
        log.info("Loading XTTS v2 model…")
        # Coqui can prompt for confirmation when pulling model assets. RunPod
        # workers are non-interactive, so we force prompt acceptance here.
        force_cpu = os.getenv("XTTS_FORCE_CPU", "0") == "1"
        try:
            with auto_accept_input():
                from TTS.api import TTS  # type: ignore
                if force_cpu:
                    log.warning("XTTS_FORCE_CPU=1 set, loading XTTS on CPU")
                    _tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2", gpu=False)
                else:
                    try:
                        _tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2", gpu=True)
                    except Exception as exc:  # noqa: BLE001
                        log.exception("GPU XTTS init failed, falling back to CPU: %s", exc)
                        _tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2", gpu=False)
        except EOFError:
            # Extra safety: if any dependency still tried to read stdin, retry once
            # with forced prompt acceptance in a clean pass.
            log.warning("XTTS init hit EOF on stdin prompt; retrying non-interactive")
            with auto_accept_input():
                from TTS.api import TTS  # type: ignore
                _tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2", gpu=False)
        log.info("XTTS v2 ready.")
    return _tts


def _reset_tts() -> None:
    global _tts
    _tts = None


def get_r2_client():
    account_id = os.getenv("R2_ACCOUNT_ID")
    access_key_id = os.getenv("R2_ACCESS_KEY_ID")
    secret_access_key = os.getenv("R2_SECRET_ACCESS_KEY")
    if not account_id or not access_key_id or not secret_access_key:
        raise RuntimeError("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required for synthesis uploads")

    return boto3.client(
        "s3",
        region_name="auto",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
    )


# ── Text chunker ───────────────────────────────────────────────────────────────
# XTTS v2 has a practical limit of ~230 chars per call.
# We split on sentence boundaries to avoid cutting words mid-thought.

MAX_CHUNK = 230

def chunk_text(text: str) -> list[str]:
    """Split text into ≤MAX_CHUNK-char sentence-boundary chunks."""
    # Normalize whitespace
    text = re.sub(r"\s+", " ", text.strip())
    # Split on sentence-ending punctuation followed by whitespace
    sentences = re.split(r"(?<=[.!?])\s+", text)
    chunks: list[str] = []
    current = ""
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
        # If a single sentence exceeds MAX_CHUNK, hard-split on word boundaries
        if len(sentence) > MAX_CHUNK:
            words = sentence.split()
            for word in words:
                if len(current) + len(word) + 1 > MAX_CHUNK:
                    if current:
                        chunks.append(current.strip())
                    current = word
                else:
                    current = (current + " " + word).strip()
        elif len(current) + len(sentence) + 1 > MAX_CHUNK:
            if current:
                chunks.append(current.strip())
            current = sentence
        else:
            current = (current + " " + sentence).strip()
    if current:
        chunks.append(current.strip())
    return [c for c in chunks if c]


# ── Audio stitcher ─────────────────────────────────────────────────────────────
# Concatenates multiple WAV byte-strings with a short silence gap between chunks
# so paragraph breaks feel natural.

def stitch_wav_chunks(wav_chunks: list[bytes], silence_ms: int = 350) -> bytes:
    """Merge multiple WAV chunks into a single WAV file."""
    import wave
    if len(wav_chunks) == 1:
        return wav_chunks[0]

    # Read params from first chunk
    with wave.open(io.BytesIO(wav_chunks[0])) as wf:
        params = wf.getparams()
        framerate = params.framerate
        n_channels = params.nchannels
        sampwidth = params.sampwidth

    # Build silence (zeros)
    silence_frames = int(framerate * silence_ms / 1000)
    silence = b"\x00" * (silence_frames * n_channels * sampwidth)

    output = io.BytesIO()
    with wave.open(output, "wb") as out_wf:
        out_wf.setparams(params)
        for i, chunk in enumerate(wav_chunks):
            with wave.open(io.BytesIO(chunk)) as in_wf:
                out_wf.writeframes(in_wf.readframes(in_wf.getnframes()))
            if i < len(wav_chunks) - 1:
                out_wf.writeframes(silence)

    return output.getvalue()


# ── Action: clone ──────────────────────────────────────────────────────────────
# Accepts base64-encoded audio (WAV/MP3/M4A) or a URL to the voice sample.
# Converts to a clean 22050 Hz mono WAV and returns it as base64.
# The caller stores this WAV in R2 and uses its URL as the voice_id.

def action_clone(job_input: dict) -> dict:
    audio_b64: str | None = job_input.get("audio_base64")
    audio_url: str | None = job_input.get("audio_url")

    if not audio_b64 and not audio_url:
        return {"error": "Provide audio_base64 or audio_url"}

    # Fetch raw bytes
    if audio_b64:
        raw = base64.b64decode(audio_b64)
        ext = job_input.get("ext", "wav")
    else:
        with urllib.request.urlopen(audio_url, timeout=30) as resp:  # noqa: S310
            raw = resp.read()
        parsed_path = urlparse(audio_url).path
        ext = parsed_path.rsplit(".", 1)[-1].lower() if "." in parsed_path else job_input.get("ext", "wav")

    ext = re.sub(r"[^a-z0-9]", "", str(ext).lower()) or "wav"

    # Write to temp file for ffmpeg
    with tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False) as tmp_in:
        tmp_in.write(raw)
        tmp_in_path = tmp_in.name

    tmp_out_path = tmp_in_path.replace(f".{ext}", "_cloned.wav")

    try:
        # Convert to 22050 Hz mono WAV — the format XTTS v2 expects
        ret = os.system(  # noqa: S605
            f'ffmpeg -y -i "{tmp_in_path}" -ar 22050 -ac 1 -c:a pcm_s16le "{tmp_out_path}" -loglevel error'
        )
        if ret != 0:
            return {"error": "ffmpeg conversion failed — ensure the input is a valid audio file"}

        with open(tmp_out_path, "rb") as f:
            wav_bytes = f.read()

        # Quick sanity: XTTS needs ≥3 s of speech. We don't enforce this server-side
        # but we report the duration so the client can warn the user.
        import wave
        with wave.open(io.BytesIO(wav_bytes)) as wf:
            duration_sec = wf.getnframes() / wf.getframerate()

        return {
            "wav_base64": base64.b64encode(wav_bytes).decode(),
            "duration_sec": round(duration_sec, 1),
            "format": "wav",
            "sample_rate": 22050,
        }
    finally:
        Path(tmp_in_path).unlink(missing_ok=True)
        Path(tmp_out_path).unlink(missing_ok=True)


# ── Action: synthesize ─────────────────────────────────────────────────────────
# Accepts text + speaker_wav_base64 (or speaker_wav_url) → returns base64 WAV.
# Text is chunked and stitched for natural paragraph-level narration.

def action_synthesize(job_input: dict) -> dict:
    text: str | None = job_input.get("text")
    speaker_b64: str | None = job_input.get("speaker_wav_base64")
    speaker_url: str | None = job_input.get("speaker_wav_url")
    language: str = job_input.get("language", "en")
    speed: float = float(job_input.get("speed", 1.0))
    slug: str = job_input.get("slug", "default")
    chapter_id: str = job_input.get("chapter_id", "chapter")

    if not text:
        return {"error": "text is required"}
    if not speaker_b64 and not speaker_url:
        return {"error": "Provide speaker_wav_base64 or speaker_wav_url"}

    # Fetch speaker WAV
    if speaker_b64:
        speaker_bytes = base64.b64decode(speaker_b64)
    else:
        with urllib.request.urlopen(speaker_url, timeout=30) as resp:  # noqa: S310
            speaker_bytes = resp.read()

    tts = get_tts()
    chunks = chunk_text(text)
    log.info("Synthesizing %d chunk(s) for %d chars of text", len(chunks), len(text))

    wav_chunks: list[bytes] = []

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as spk_tmp:
        spk_tmp.write(speaker_bytes)
        spk_tmp_path = spk_tmp.name

    try:
        for i, chunk in enumerate(chunks):
            log.info("Chunk %d/%d (%d chars)", i + 1, len(chunks), len(chunk))
            out_buf = io.BytesIO()
            wav = tts.tts(
                text=chunk,
                speaker_wav=spk_tmp_path,
                language=language,
                speed=speed,
            )
            # tts.tts returns a list of floats; convert to WAV bytes via soundfile
            import soundfile as sf  # type: ignore
            sf.write(out_buf, wav, 22050, format="WAV", subtype="PCM_16")
            wav_chunks.append(out_buf.getvalue())
    finally:
        Path(spk_tmp_path).unlink(missing_ok=True)

    stitched = stitch_wav_chunks(wav_chunks)

    # Calculate output duration
    import wave
    with wave.open(io.BytesIO(stitched)) as wf:
        duration_sec = wf.getnframes() / wf.getframerate()

    safe_slug = re.sub(r"[^a-z0-9-]", "-", slug.lower()).strip("-") or "default"
    safe_chapter = re.sub(r"[^a-z0-9-]", "-", chapter_id.lower()).strip("-") or "chapter"
    key = f"audio/books/{safe_slug}/{safe_chapter}.wav"

    r2 = get_r2_client()
    r2.put_object(
        Bucket=os.environ["R2_BUCKET_NAME"],
        Key=key,
        Body=stitched,
        ContentType="audio/wav",
    )

    return {
        "audio_url": key,
        "duration_sec": round(duration_sec, 1),
        "format": "wav",
        "sample_rate": 22050,
        "chunks_processed": len(chunks),
    }


# ── RunPod handler ─────────────────────────────────────────────────────────────

def handler(job: dict) -> dict:
    job_input: dict = job.get("input", {})
    action: str = job_input.get("action", "synthesize")

    try:
        if action == "clone":
            return action_clone(job_input)
        elif action == "synthesize":
            return action_synthesize(job_input)
        else:
            return {"error": f"Unknown action: {action}. Use 'clone' or 'synthesize'."}
    except EOFError:
        # Last-resort recovery for any hidden interactive prompt path.
        log.warning("EOF from interactive prompt path; retrying once non-interactively")
        _reset_tts()
        with auto_accept_input():
            if action == "clone":
                return action_clone(job_input)
            elif action == "synthesize":
                return action_synthesize(job_input)
            return {"error": f"Unknown action: {action}. Use 'clone' or 'synthesize'."}
    except Exception as exc:  # noqa: BLE001
        log.exception("Handler error")
        return {"error": str(exc)}


if __name__ == "__main__":
    log.info("Starting RunPod serverless worker (XTTS v2 loads on first job)…")
    runpod.serverless.start({"handler": handler})
