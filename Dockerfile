# D39. The Node version follows .node-version (tests/unit/dockerfile.test.ts checks it).
FROM node:26.13.1-alpine3.24 AS base
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
FROM node:26.13.1-alpine3.24
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
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "dist/cli.js", "health"]
CMD ["node", "dist/main.js"]
