# 用完整 node 镜像(非 slim):自带 git 与编译工具链,agent 场景缺件风险更低
ARG NODE_TAG=26
FROM node:${NODE_TAG}

# 开发常用工具(为 agent 的工作环境预装):
#   git bash curl wget ca-certificates   — 基础工具链(完整镜像已自带,显式安装保证工具齐全)
#   openssh-client                       — git 走 SSH 拉取
#   build-essential python3              — 编译原生模块(node-gyp)/脚本执行
#   jq ripgrep fd-find tree              — agent 检索与数据处理的高频工具
#   unzip zip less procps sqlite3        — 归档、分页、进程查看、本地库
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git bash curl wget ca-certificates openssh-client \
        build-essential python3 \
        jq ripgrep fd-find tree \
        unzip zip less procps sqlite3 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd

# 锁版本:developer preview 期破坏性变更多,不追 latest(DESIGN.md R1)
ARG DSH_VERSION=0.2.2-rc.5
RUN npm install -g @deepseek-ai/dsh@${DSH_VERSION} && npm cache clean --force

# dsh plugin 命令把参数转发给 pnpm;本地 profile 插件(out-of-tree bundle)必需
# dsh-app-boot 要求 pnpm >= 10 且用 hoisted linker,版本锁死避免行为漂移。
ARG PNPM_VERSION=10.34.9
RUN npm install -g pnpm@${PNPM_VERSION}

# 数据目录:HOME 决定 UI 目录选择器的起点和 agent shell 的 ~,DSH_HOME 决定 dsh 配置根
# 两者拆开:工作区默认落 /data/workspace,而配置/凭据/会话轨迹继续留在 /data/dsh
ENV HOME=/data/workspace
ENV DSH_HOME=/data/dsh/.dsh
WORKDIR /data/workspace

COPY auth-proxy.js /usr/local/bin/auth-proxy.js
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3080
ENTRYPOINT ["docker-entrypoint.sh"]
