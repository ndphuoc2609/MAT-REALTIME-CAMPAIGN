FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3-minimal \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN mkdir -p /data \
    && chown -R node:node /app /data /ms-playwright
USER node
EXPOSE 8787
CMD ["npm", "start"]
