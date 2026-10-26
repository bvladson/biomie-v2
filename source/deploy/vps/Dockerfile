FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install --global bun@1.4.2
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY \
    VITE_GOOGLE_AUTH_ENABLED=false \
    NODE_OPTIONS=--max-old-space-size=2560
RUN bun run build \
 && for entry in worker bootstrap-sync worker-ctl credentials-ctl omie-probe omie-trace-sync stock-probe stock-movements-probe stock-movements-load stock-suppliers-load reprocess-raw; do \
      bun build scripts/$entry.ts --target=node --format=esm --outfile=.output/$entry.mjs || exit 1; \
    done

FROM node:24-bookworm-slim AS runtime
ARG GIT_COMMIT=unknown
LABEL org.opencontainers.image.revision=$GIT_COMMIT \
      org.opencontainers.image.title="biomie-v2-web"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 BIOMIE_GIT_COMMIT=$GIT_COMMIT
WORKDIR /app
COPY --from=build --chown=node:node /app/.output ./.output
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/auth').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", ".output/server/index.mjs"]
