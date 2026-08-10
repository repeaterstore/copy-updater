# Playwright's official image ships Chromium plus every system library and font
# it needs. Building on a stock node image means chasing libgbm/libnss3/etc by hand.
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS base
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# ---------- deps ----------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---------- build ----------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Build-time placeholders: the real values come from Railway at runtime. Next
# evaluates some module-level code during build, so these must be non-empty.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
ENV AUTH_SECRET=build-time-placeholder-not-used-at-runtime
RUN npm run build

# ---------- runtime ----------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/data

COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# The capture pipeline bundles lib/browser/*.ts with esbuild at runtime (one
# source of truth for the ops code that runs in the page and on the server), so
# those TypeScript sources must exist in the image. Standalone output contains
# only compiled server chunks, so without this the first capture fails with
# "Could not resolve lib/browser/capture-entry.ts".
COPY --from=build /app/lib ./lib

# Standalone tracing can't see these: the SingleFile browser bundle is imported
# by a specifier the bundler externalises, and the migration scripts run outside
# the Next build graph.
COPY --from=build /app/node_modules/single-file-cli ./node_modules/single-file-cli
# nft only partially traces playwright: lib/ makes it in but browsers.json does
# not, and coreBundle.js requires it at module load — so every page importing
# the capture actions 500s with "Cannot find module browsers.json". Copy the
# complete packages over the traced shards.
COPY --from=build /app/node_modules/playwright ./node_modules/playwright
COPY --from=build /app/node_modules/playwright-core ./node_modules/playwright-core
COPY --from=build /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=deps  /app/node_modules/drizzle-kit ./node_modules/drizzle-kit
COPY --from=deps  /app/node_modules/tsx ./node_modules/tsx
COPY --from=deps  /app/node_modules/.bin ./node_modules/.bin
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/db ./db
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /app/package.json ./package.json

RUN mkdir -p /data && chown -R pwuser:pwuser /data /app
USER pwuser

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Migrate then serve. Railway restarts the container on failure, so a failed
# migration surfaces loudly instead of booting a server against a stale schema.
CMD ["sh", "-c", "node_modules/.bin/tsx scripts/migrate.ts && node server.js"]
