# Root Dockerfile — RunPod voice worker (XTTS v2)
# Slim deterministic build to reduce remote builder layer-commit failures.
FROM python:3.11-slim

WORKDIR /app

ENV COQUI_TOS_AGREED=1
ENV XTTS_FORCE_CPU=1
ENV PIP_NO_CACHE_DIR=1
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV PYTHONDONTWRITEBYTECODE=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    git \
    libsndfile1 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY scripts/voice-server/requirements.txt ./requirements.txt

# Install CPU torch first so downstream dependencies reuse it.
RUN pip install --index-url https://download.pytorch.org/whl/cpu \
    torch==2.5.1 torchaudio==2.5.1 \
    && pip install -r requirements.txt

COPY scripts/voice-server/handler.py ./handler.py

CMD ["python", "-u", "handler.py"]
