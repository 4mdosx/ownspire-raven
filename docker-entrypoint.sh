#!/bin/sh
set -e

# HOME 用于 UI 目录选择器/agent shell 的 ~;dsh 配置根是 $DSH_HOME(=~/.dsh)
export HOME="${HOME:-/data/workspace}"
export DSH_HOME="${DSH_HOME:-/data/dsh/.dsh}"
AUTH_HOME="/data/dsh"
mkdir -p "$AUTH_HOME" "$DSH_HOME" "$HOME" /run
cd "$HOME"

# ---------- 鉴权凭据(首次启动自动生成并持久化) ----------
AUTH_USER="${AUTH_USER:-workbench}"
export AUTH_USER

SECRET_FILE="$AUTH_HOME/auth-secret"
if [ -z "${AUTH_SECRET:-}" ]; then
    if [ -s "$SECRET_FILE" ]; then
        AUTH_SECRET=$(cat "$SECRET_FILE")
    else
        AUTH_SECRET=$(openssl rand -hex 32)
        printf '%s\n' "$AUTH_SECRET" > "$SECRET_FILE"
        chmod 600 "$SECRET_FILE"
    fi
fi
export AUTH_SECRET

PASSWORD_FILE="$AUTH_HOME/auth-password"
if [ -z "${AUTH_PASSWORD:-}" ]; then
    if [ -s "$PASSWORD_FILE" ]; then
        AUTH_PASSWORD=$(cat "$PASSWORD_FILE")
    else
        AUTH_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=')
        printf '%s\n' "$AUTH_PASSWORD" > "$PASSWORD_FILE"
        chmod 600 "$PASSWORD_FILE"
        echo "[entrypoint] 已生成随机登录密码: $AUTH_PASSWORD (用户名: $AUTH_USER)"
        echo "[entrypoint] 密码同时保存在 $PASSWORD_FILE"
    fi
fi
export AUTH_PASSWORD

# ---------- dsh:只监听容器内 127,由鉴权壳代理 ----------
DSH_ARGS="--no-open --host 127.0.0.1 --port 3081"
if [ -n "${DSH_PUBLIC_URL:-}" ]; then
    DSH_ARGS="$DSH_ARGS --public-url $DSH_PUBLIC_URL"
fi
DSH_TRUST="127.0.0.1:3081"
if [ -n "${DSH_TRUSTED_HOST:-}" ]; then
    DSH_TRUST="$DSH_TRUST $DSH_TRUSTED_HOST"
fi
DSH_ARGS="$DSH_ARGS --trusted-host $DSH_TRUST"

# dsh 把带 token 的访问地址打到 stdout,这里抓出来给鉴权壳自动注入
rm -f /run/dshlog /run/dsh-token
mkfifo /run/dshlog
dsh web $DSH_ARGS > /run/dshlog 2>&1 &
DSPID=$!

(
    while IFS= read -r line; do
        printf '%s\n' "$line"
        case "$line" in
            *'?token='*)
                tok=$(printf '%s\n' "$line" | sed -n 's/.*[?&]token=\([^[:space:]]*\).*/\1/p')
                if [ -n "$tok" ]; then
                    printf '%s' "$tok" > /run/dsh-token
                fi
                ;;
        esac
    done < /run/dshlog
) &
LOGPID=$!

i=0
while [ ! -s /run/dsh-token ] && [ "$i" -lt 60 ]; do
    sleep 1
    i=$((i + 1))
done
if [ ! -s /run/dsh-token ]; then
    echo "[entrypoint] 警告:60 秒内未捕获 dsh token" >&2
fi

# ---------- 启动局域网鉴权壳 ----------
node /usr/local/bin/auth-proxy.js &
PROXYPID=$!

trap 'kill "$DSPID" "$LOGPID" "$PROXYPID" 2>/dev/null || true' TERM INT EXIT
wait "$PROXYPID"
