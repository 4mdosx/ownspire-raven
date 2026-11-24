ARG NODE_TAG=24-slim
FROM node:${NODE_TAG}

# socat 仅作 dsh 不支持 --host 时的兜底转发
RUN apt-get update \
    && apt-get install -y --no-install-recommends socat \
    && rm -rf /var/lib/apt/lists/*

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
