#!/bin/sh
set -e

mkdir -p "$HOME" /data/workspace
cd /data/workspace

# dsh 拒绝绑 0.0.0.0(官方安全策略,防 RCE 暴露),只接受具体地址。
# 容器端口映射的 DNAT 流量目的地址就是容器自身 IP,绑它即可:
HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')

if [ -n "$HOST_IP" ]; then
    echo "[entrypoint] dsh web 绑定容器地址 ${HOST_IP}:3080"
    exec dsh web --no-open --host "$HOST_IP" --port 3080
else
    # 兜底:dsh 绑 127.0.0.1,socat 把 0.0.0.0:3081 转发到 127.0.0.1:3080
    # (宿主侧端口映射需改用 3081)
    echo "[entrypoint] 未能探测容器 IP,启用 socat 转发(宿主端口改用 3081)" >&2
    socat TCP-LISTEN:3081,fork,reuseaddr TCP:127.0.0.1:3080 &
    exec dsh web --no-open
fi
