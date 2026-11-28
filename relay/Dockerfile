FROM oven/bun:1-slim

WORKDIR /app
COPY server.ts ./server.ts

USER bun
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

CMD ["bun", "server.ts"]
