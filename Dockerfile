# Single-container deployment (00 §"Scope decisions": Docker, runs anywhere).
#
# node:sqlite is built in, so there is no native module to compile and the
# image needs no toolchain at runtime.

FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* tsconfig.json ./
RUN npm ci

COPY src ./src

# R38.5 — the development login bypass must be ABSENT from a production
# artefact, not merely disabled in it. It is deleted before the build, so it
# cannot reach the image even if DEV_LOGIN were somehow set. config.ts refuses
# to start in that case anyway (R38.3); this is the second, harder line.
# The health page reports its absence (F23.13).
RUN rm -f src/auth/dev-login.ts && npm run build


FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    HOST=0.0.0.0

# Runs unprivileged. The data volume is the only writable path it needs.
RUN mkdir -p /data && chown -R node:node /data

COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
VOLUME ["/data"]
EXPOSE 8080

# F27.3's machine-readable endpoint doubles as the container health check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
