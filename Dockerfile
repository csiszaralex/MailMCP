# D39. The one place for the base image, pinned by digest (the multi-arch index). Its Node version
# follows .node-version; tests/unit/docker-image.test.ts checks both.
ARG NODE_IMAGE=node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5

FROM ${NODE_IMAGE} AS base
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The Node 26 image has no corepack: install the pnpm version package.json pins.
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.split('+')[0].split('@')[1]")"

FROM base AS build
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --ignore-scripts --prod

# The runtime stage starts from the plain image, so pnpm and npm's global packages stay out.
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    MAILMCP_HOST=0.0.0.0 \
    MAILMCP_DATA_DIR=/data \
    MAILMCP_ACCOUNTS_FILE=/config/accounts.yaml
WORKDIR /app
# A fresh named volume copies this directory's owner, so the node user can write the store.
RUN mkdir /data && chown node:node /data
# package.json carries "type": "module".
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8787
# --timeout must stay above the probe's own 3 s deadline (realIo in src/cli.ts), so the probe
# reports its reason instead of being killed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "dist/cli.js", "health"]
CMD ["node", "dist/main.js"]
