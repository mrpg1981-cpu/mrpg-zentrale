FROM node:22-bookworm-slim

# Werkzeuge für Terminal, Git und Build von node-pty
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client bash curl ca-certificates python3 make g++ tini docker.io \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
RUN rm -rf data && mkdir -p /data /projekte && chown -R node:node /app /data /projekte

# KI-CLIs werden beim Start nach /data/npm-global installiert (Knopf in „KI-Konten“)
# oder hier fest ins Image:
ARG INSTALL_CLIS=1
RUN if [ "$INSTALL_CLIS" = "1" ]; then npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli && npm cache clean --force; fi

USER node
ENV HOST=0.0.0.0 PORT=7777 ZENTRALE_DATA=/data PROJEKTE_DIR=/projekte NO_BROWSER=1 SHELL=/bin/bash
VOLUME ["/data"]
EXPOSE 7777
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
