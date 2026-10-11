FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache su-exec
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY public ./public
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
ENV NODE_ENV=production DATA_DIR=/app/data PORT=3000
RUN chmod +x /usr/local/bin/entrypoint.sh && mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "--no-warnings", "server.js"]
