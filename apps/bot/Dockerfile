# ClinicAI WhatsApp bot — Railway image. Build context: repository root.
#   docker build -f apps/bot/Dockerfile -t clinicai-bot .
# F33: exact Node version and image digest (update both together: docs/deploy.md).
FROM node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS base
ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_HOME=/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app

# 1) pnpm through corepack, checked against the hash of package.json "packageManager"; kept in
#    /corepack so the runtime user runs it without the network (migrations, start).
COPY package.json ./
RUN corepack enable pnpm && corepack install && chmod -R a+rX /corepack

# 2) Dependencies of the bot and its workspace packages (dev deps included: prisma CLI, tsx).
COPY pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/bot/package.json apps/bot/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/prisma.config.ts packages/db/
COPY packages/db/prisma packages/db/prisma
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --prod=false --filter "@clinicai/bot..."

# 3) Sources + Prisma client generation.
COPY packages packages
COPY apps/bot apps/bot
RUN pnpm --filter @clinicai/db generate

USER node
EXPOSE 3008
# Railway injects PORT. Migrations run as the service's pre-deploy command (docs/deploy.md, step 2).
CMD ["pnpm", "--filter", "@clinicai/bot", "start"]
