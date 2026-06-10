# ── Nexus Director Voice Worker ───────────────────────────────────────────────
# Use CPU-safe runtime so RunPod fitness checks do not crash-loop on Blackwell
# CUDA/PyTorch mismatches. This guarantees queue -> in_progress behavior.
FROM python:3.11-slim

WORKDIR /app

ENV COQUI_TOS_AGREED=1
ENV XTTS_FORCE_CPU=1
ENV PIP_NO_CACHE_DIR=1
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV PYTHONDONTWRITEBYTECODE=1

# System dependencies — ffmpeg for audio conversion, libsndfile for soundfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    git \
    libsndfile1 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Python dependencies
COPY requirements.txt .
# Install CPU torch first so downstream deps (e.g. TTS) reuse it instead of
# pulling a second torch variant in another layer.
RUN pip install --index-url https://download.pytorch.org/whl/cpu \
    torch==2.5.1 torchaudio==2.5.1 \
    && pip install -r requirements.txt

# Do not bake XTTS weights into the image. It makes the serverless image much
# larger and workers can get stuck initializing before they ever pull a job.
# The model is still lazy-loaded by handler.py on the first synth request.

# Worker code
COPY handler.py .

CMD ["python", "-u", "handler.py"]
