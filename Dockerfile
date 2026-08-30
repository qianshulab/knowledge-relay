FROM node:22.23.2-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
COPY scripts/build-sqlite-native.mjs ./scripts/build-sqlite-native.mjs
RUN npm ci \
    && npm run build:sqlite-native \
    && node -e "const [major,minor,patch]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&(minor<23||(minor===23&&patch<2))))throw new Error('Node.js 22.23.2+ required')"
COPY tsconfig.json ./
COPY src ./src
COPY frontend ./frontend
COPY scripts ./scripts
COPY obsidian-plugin ./obsidian-plugin
RUN npm run build \
    && npm run package:plugin \
    && npm prune --omit=dev \
    && npm run verify:sqlite

FROM node:22.23.2-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/app/data NANOBOT_MANAGED=false
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web-dist ./web-dist
COPY --from=build /app/release ./release
COPY --from=build /app/scripts ./scripts
RUN apk add --no-cache su-exec \
    && mkdir -p /app/data \
    && chown -R node:node /app \
    && chmod +x /app/scripts/docker-entrypoint.sh
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
