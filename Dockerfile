# Single-container deployment (00: Docker, runs anywhere).
#
# node:sqlite is built in, so there is no native module to compile and the
# runtime image needs no toolchain.
#
# Stages:
#   deps     node_modules only, so a source edit does not reinstall
#   dev      full source *including* the dev login bypass — dev/seed/test only
#   build    source WITHOUT the bypass, compiled to dist
#   runtime  dist and node_modules, unprivileged
#
# The split between `dev` and `build` is what makes R38.5 real: the bypass
# exists in one stage and cannot reach the other, rather than being disabled by
# a flag somebody might flip.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci


FROM deps AS dev
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
ENV DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 8080
CMD ["npm", "run", "dev"]


FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src

# R38.5 — the development login bypass must be ABSENT from the production
# artefact, not merely disabled in it.
#
# Compiled first, then removed. Deleting the source *before* compiling looks
# stricter but does not work: app.ts imports the module dynamically, and tsc
# cannot resolve a specifier whose file is gone, so the build fails outright.
# What ships is the `dist` directory, and the bypass is not in it — which is
# what R38.5 is asking for. The source is removed too, so no layer that could
# be copied forward still carries it.
#
# config.ts refuses to start if DEV_LOGIN is set anywhere production-shaped
# (R38.3); this is the second, harder line. The health page reports its
# absence (F23.13), and at runtime the dynamic import simply resolves to null.
RUN npm run build \
 && rm -f dist/auth/dev-login.js dist/auth/dev-login.js.map src/auth/dev-login.ts \
 && test ! -f dist/auth/dev-login.js


FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    HOST=0.0.0.0

# Runs unprivileged. The data volume is the only writable path it needs.
RUN mkdir -p /data && chown -R node:node /data

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# F21.1 · The icons the manifest names. dist/web/icon-files.js reads them from
# ../../assets at startup, so without this the image exits on boot with ENOENT
# for /app/assets/icon-192.png — the built image never started at all.
COPY --chown=node:node assets ./assets

USER node
VOLUME ["/data"]
EXPOSE 8080

# F27.3's machine-readable endpoint doubles as the container health check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]


# ---------------------------------------------------------------------------
# The public demo.
#
# Its data is invented and disposable, so this stage needs no volume, no
# backups and no secrets — which is what lets it run on a scale-to-zero host
# for nothing. The database is seeded at *build* time and baked into the image:
# seeding takes about twenty seconds, and doing it on boot would hand that wait
# to whichever visitor happened to arrive on a cold start.
#
# Baking it in is also how the demo resets, but not by itself. `docker run
# --rm` throws the writable layer away, so there a restart really is a reset —
# on a hosted machine it is not. A Fly machine that stops when idle and starts
# on the next request keeps its filesystem across the pause, so without the
# copy below a visitor's typing would sit in the demo until the next deploy.
#
# So the seed is kept twice: `demo.seed.sqlite` is the pristine one and is never
# opened by the app, and the entrypoint copies it over `demo.sqlite` on every
# boot. Copying a few megabytes costs milliseconds, where re-seeding costs the
# twenty seconds above — which means the demo can reset on every wake from idle
# rather than only when something is deployed. That is what makes the privacy
# policy's "it resets periodically" true.
#
#   docker build --target demo -t pathayam-demo .
#   docker run --rm -p 8080:8080 pathayam-demo
# ---------------------------------------------------------------------------
FROM runtime AS demo

ENV DEMO_MODE=1 \
    DATABASE_PATH=/app/demo.sqlite

USER root
# The seed's dates end on the day it runs, so a seed baked months ago shows a
# demo whose current month is empty. The weekly scheduled deploy re-seeds by
# passing a new SEED_STAMP: an ARG whose value changes misses the build cache
# at the next RUN, so the seed below runs again even though no source changed.
# Left unset, a local build behaves exactly as before.
ARG SEED_STAMP=
# SQLite writes -wal and -shm beside the database, so the directory has to be
# writable by the runtime user, not just the file.
#
# The checkpoint matters: the seed runs in WAL mode, so without folding the log
# back into the main file the snapshot would be an empty-looking database with
# all its contents in a -wal file left behind.
RUN node dist/demo.js \
 && node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; \
      const db = new DatabaseSync('/app/demo.sqlite'); \
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); \
      db.close();" \
 && cp /app/demo.sqlite /app/demo.seed.sqlite \
 && chown -R node:node /app
USER node

# Restore the pristine copy, then hand PID 1 to node with exec so it still
# receives the signals Fly sends it.
CMD ["sh", "-c", "rm -f /app/demo.sqlite /app/demo.sqlite-wal /app/demo.sqlite-shm && cp /app/demo.seed.sqlite /app/demo.sqlite && exec node dist/main.js"]
