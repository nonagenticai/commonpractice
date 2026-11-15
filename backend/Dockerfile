ARG BASE_REGISTRY=docker.io
FROM ${BASE_REGISTRY}/oven/bun:1.3.13

# Phase 2-C: the backend drives Kata run pods via the kubectl binary (Bun's HTTPS
# stack can't reach the k3s apiserver, but kubectl can). Download a server-matched
# kubectl with bun's own fetch — no extra base image / registry-mirror dependency.
# Unused when RUN_BACKEND=subprocess.
RUN bun -e "const r=await fetch('https://dl.k8s.io/release/v1.35.5/bin/linux/amd64/kubectl');if(!r.ok)process.exit(1);await Bun.write('/usr/local/bin/kubectl',await r.arrayBuffer());" \
  && chmod +x /usr/local/bin/kubectl \
  && kubectl version --client=true

WORKDIR /app

# Deps first for layer caching
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Source + config
COPY tsconfig.json bunfig.toml drizzle.config.ts index.ts ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts

EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD bun run -e "fetch('http://localhost:8790/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["bun", "run", "start"]
