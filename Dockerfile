# Render (Free) এর জন্য: Node + yt-dlp + ffmpeg
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ffmpeg curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY server.js index.html package.json ./

# Render PORT নিজেই দেয়; 0.0.0.0 না দিলে বাইরে থেকে খোলা যায় না
ENV HOST=0.0.0.0
EXPOSE 10000
CMD ["node", "server.js"]
