FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY lib ./lib
COPY public ./public
COPY art ./art
COPY scripts/server.mjs ./scripts/server.mjs
COPY config.example.json ./
RUN mkdir -p /data/art-control && chown -R node:node /data
USER node
ENV HOST=0.0.0.0 PORT=4321 DATA_DIR=/data
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["node", "-e", "fetch('http://127.0.0.1:4321/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "scripts/server.mjs"]
