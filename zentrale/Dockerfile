FROM node:22-bookworm-slim
# KI-CLIs (Login per Abo, keine API-Keys)
RUN npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli \
 && npm cache clean --force
WORKDIR /app
COPY . .
ENV HOST=0.0.0.0 PORT=7777 ZENTRALE_DATA=/data NO_BROWSER=1
VOLUME /data
EXPOSE 7777
CMD ["node", "server.js"]
