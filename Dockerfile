FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --include=optional --omit=dev

COPY . .
RUN mkdir -p /app/data \
  && chown -R node:node /app

USER node

EXPOSE 4321

CMD ["node", "server.community.js"]
