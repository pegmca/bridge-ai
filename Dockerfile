FROM node:22-alpine

WORKDIR /app

# Only copy what is needed to run; the real config is mounted at runtime.
COPY package.json ./
COPY src ./src

RUN chown -R node:node /app
USER node

EXPOSE 8787

# Expect a mounted config.json at /app/config.json (see README / run notes).
CMD ["node", "src/index.js", "server", "--config", "/app/config.json"]
