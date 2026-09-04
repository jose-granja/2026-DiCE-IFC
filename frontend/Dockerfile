# syntax=docker/dockerfile:1

# Next.js frontend, development image.
#
# docker-compose_dev.yml bind-mounts ./frontend over /app and keeps
# /app/node_modules as an anonymous volume, so the modules installed here
# survive the mount. Next 16 runs Turbopack by default — no --turbopack flag.

FROM node:24-bookworm-slim

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=development \
    PORT=3000

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

COPY . .

EXPOSE 3000

# `next dev` writes to .next/dev in Next 16, so it can run alongside a build.
CMD ["npm", "run", "dev", "--", "--hostname", "0.0.0.0"]
