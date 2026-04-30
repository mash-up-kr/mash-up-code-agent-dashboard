FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node package*.json ./
RUN npm ci --include=optional --omit=dev

COPY --chown=node:node . .
RUN mkdir -p /app/data \
  && chown node:node /app/data

USER node

EXPOSE 4321

CMD ["node", "server.community.js"]
