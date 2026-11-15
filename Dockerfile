# Web/server mode (PBI-101): the same React UI served by a Node gateway.
#
#   docker build -t nats-jetstream-studio .
#   docker run -p 8080:8080 -v studio-data:/data \
#     -e STUDIO_OIDC_ISSUER=https://login.example.com -e STUDIO_OIDC_CLIENT_ID=studio \
#     -e STUDIO_PUBLIC_URL=https://studio.example.com nats-jetstream-studio
#
# See docs/web-mode.md for every setting.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Scripts are skipped: they would download Electron, which the server does not need.
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build:web

FROM node:24-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    STUDIO_DATA_DIR=/data \
    STUDIO_WEB_ROOT=/app/web \
    STUDIO_CONTEXT_DIR=/config/nats/context
WORKDIR /app
COPY --from=build /app/dist/server/index.cjs ./server/index.cjs
COPY --from=build /app/dist/web ./web
RUN mkdir -p /data /config && chown -R node:node /data /config
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.cjs"]
