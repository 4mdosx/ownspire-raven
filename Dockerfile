ARG NODE_TAG=26-slim
FROM node:${NODE_TAG}

# socat 仅作 dsh 不支持 --host 时的兜底转发
# 开发常用工具(为 agent 的工作环境预装):
#   git bash curl wget ca-certificates   — 基础工具链(slim 默认不带 git,缺它 UI 建不了工作空间)
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
        socat \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd

# 锁版本:developer preview 期破坏性变更多,不追 latest(DESIGN.md R1)
ARG DSH_VERSION=0.2.2-rc.5
RUN npm install -g @deepseek-ai/dsh@${DSH_VERSION} && npm cache clean --force

# 数据目录:HOME 即 ~/.dsh 所在,由宿主挂载持有
ENV HOME=/data/dsh
WORKDIR /data/workspace

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3080
ENTRYPOINT ["docker-entrypoint.sh"]
