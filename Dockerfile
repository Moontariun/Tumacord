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
    WEB_DIR=/app/dist-web
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist-web ./dist-web
VOLUME ["/data"]
EXPOSE 4600
CMD ["node", "dist-server/server-bundle.cjs"]
