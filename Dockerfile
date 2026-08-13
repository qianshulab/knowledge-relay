FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci && node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<13))throw new Error('Node.js 22.13+ required')"
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY obsidian-plugin ./obsidian-plugin
RUN npm run build && npm run package:plugin && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/app/data NANOBOT_MANAGED=false
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
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
