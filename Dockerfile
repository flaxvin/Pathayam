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

USER node
VOLUME ["/data"]
EXPOSE 8080

# F27.3's machine-readable endpoint doubles as the container health check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
