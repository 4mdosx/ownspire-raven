# node:24-bookworm-slim。digest 与 navi / creative-atlas 保持一致，避免三个基础镜像各自漂移。
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# `npm run build` 会先跑 prepare-next，把 `.next` 链到 /tmp。那是本机 WorkBuddy
# 拦截 rename 的绕行，镜像里没有这个拦截。链出去之后，下面 `COPY .next` 拿到的是
# 断链，构建产物不在这一层里 —— 所以镜像里直接调 next。
#
# ⚠️ 与 atlas 的差别：raven **需要一个存在的 config/ 目录**才能构建。
# Next 的构建期会执行 route 的模块顶层代码，而 `app/healthz/route.ts` 会在
# 模块加载时读配置。所以镜像里放一份占位配置，真配置由 compose 挂进
# /data/raven/raven.config.json（RAVEN_CONFIG 指向它）。
RUN mkdir -p public config \
  && cp config/raven.config.docker.json config/raven.config.json \
  && ./node_modules/.bin/next build \
  && npm prune --omit=dev

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runner

WORKDIR /app

# infra 的 deploy 会传 RAVEN_VERSION=<7位 commit>，/healthz 靠它报版本。
# 与 ATLAS_VERSION / NAVI_VERSION 是同一套机制。
ARG RAVEN_VERSION=dev
ENV NODE_ENV=production
ENV PORT=5800
ENV RAVEN_VERSION=$RAVEN_VERSION
# 受管根目录与数据目录都落在数据卷上：
#   /data/raven/workspace/   ← 文件管理器唯一可见的树（配额只算它）
#   /data/raven/scripts/     ← 脚本目录
#   /data/raven/tmp/         ← 临时脚本目录
#   /data/raven/clipboard/   ← 剪切板附件
#   /data/raven/raven.db     ← SQLite
# ⚠️ rootPath 是 /data/raven 而不是 /data：配置加载拒绝文件系统根那一层，
# 而 /data 在容器里就是「一段的根」。
ENV RAVEN_DATA_DIR=/data
ENV RAVEN_CONFIG=/data/raven/raven.config.json

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/next.config.js ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/config ./config

USER node

EXPOSE 5800

CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "5800"]
