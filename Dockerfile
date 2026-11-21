# Render (Free) এর জন্য: Node + yt-dlp (Chrome-এর মতো impersonate সহ) + ffmpeg
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -U "yt-dlp[default,curl-cffi]"

ENV PATH="/opt/venv/bin:$PATH" \
    YTDLP_PIP=/opt/venv/bin/pip \
    IMPERSONATE=1 \
    HOST=0.0.0.0

WORKDIR /app
COPY server.js index.html package.json ./

EXPOSE 10000
CMD ["node", "server.js"]
