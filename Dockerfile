# Node 22+ (eMudhra CA advisory: need >=22.23.4) + FFmpeg for large-audio split
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
  && update-ca-certificates \
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
