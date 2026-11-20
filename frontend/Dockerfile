ARG BASE_REGISTRY=docker.io
FROM ${BASE_REGISTRY}/oven/bun:1.4.4 AS build

# Vite bakes these into the client bundle at build time (import.meta.env). The SPA
# reads them in src/lib/services/keycloak.ts for browser OIDC. CI passes the prod
# values as --build-arg; AUTH_BYPASS only takes effect in a DEV build (never prod).
ARG VITE_KEYCLOAK_URL
ARG VITE_KEYCLOAK_REALM
ARG VITE_KEYCLOAK_CLIENT_ID
ARG VITE_AUTH_BYPASS
ENV VITE_KEYCLOAK_URL=$VITE_KEYCLOAK_URL
ENV VITE_KEYCLOAK_REALM=$VITE_KEYCLOAK_REALM
ENV VITE_KEYCLOAK_CLIENT_ID=$VITE_KEYCLOAK_CLIENT_ID
ENV VITE_AUTH_BYPASS=$VITE_AUTH_BYPASS

WORKDIR /app
COPY package.json bun.lock* ./
# ⛔ NO `|| bun install` FALLBACK. The fallback made a DRIFTED `bun.lock` invisible: --frozen-lockfile
# is the gate that says "the shipped image resolves exactly what the repo committed", and falling
# back to a plain install on its failure resolves DIFFERENT versions into the image and reports
# success. A lockfile that cannot satisfy the manifest is a repo defect and belongs in a red build,
# not in a silently different bundle. Verified before removal: `bun install --frozen-lockfile`
# against the committed frontend/bun.lock succeeds — "Checked 221 installs across 317 packages (no
# changes)" — so the fallback was never load-bearing.
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM ${BASE_REGISTRY}/oven/bun:1.4.4
WORKDIR /app
COPY --from=build /app/build ./build
COPY --from=build /app/server.js ./server.js
COPY --from=build /app/package.json ./package.json
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
# ⛔ `bun -e`, NOT `bun run -e`. `bun run` expects a FILE OR SCRIPT NAME; given `-e` it prints its
# usage banner, evaluates nothing, and EXITS 0 — measured, not inferred. So this HEALTHCHECK
# reported `healthy` unconditionally, including with the server dead. `bun -e` evaluates the script
# and propagates its exit code (measured: 1 against a closed port, 0 against a live one).
#
# ⚠️ AND THIS GATES NOTHING IN PRODUCTION — said plainly so nobody re-reads this as a P1 that was
# sat on. Kubernetes ignores a container's own HEALTHCHECK entirely and uses its own httpGet
# liveness/readiness probes, and CI's smoke step curls the published port directly
# (.github/workflows/ci-cd.yaml, "Wait for ready + smoke tests") rather than consulting container
# health. The audience for this line is `docker ps` and `docker compose`, i.e. a developer running
# the image locally — who was, until now, told a dead frontend was healthy.
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"
# server.js runs under Node-compatible APIs; Bun serves it fine.
CMD ["bun", "run", "server.js"]
