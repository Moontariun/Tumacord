FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4600 \
    DATA_DIR=/data \
    WEB_DIR=/app/dist-web \
    TUMACORD_SERVE_WEB=1
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist-web ./dist-web
RUN mkdir -p /data && chown -R node:node /app /data
VOLUME ["/data"]
EXPOSE 4600
USER node
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 \
  CMD NODE_TLS_REJECT_UNAUTHORIZED=0 node -e "fetch((process.env.TLS_CERT_FILE?'https':'http')+'://127.0.0.1:4600/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist-server/server-bundle.cjs"]
