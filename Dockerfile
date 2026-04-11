# Node 20 + FFmpeg (required for splitting audio over ~25 MB before Whisper API)
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY scripts ./scripts

# Reproducible install + verify dependency age + audit (requires network for audit)
RUN npm ci --omit=dev \
  && node scripts/check-minimum-release-age.mjs \
  && npm audit --audit-level=moderate

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
