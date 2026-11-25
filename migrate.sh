#!/usr/bin/env bash
# 迁移工具：过滤并打包 ${DATA_DIR}，在另一台电脑恢复部署。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROG="$(basename "$0")"
STAGE=""
INCLUDE_SECRETS=0
INCLUDE_PROJCACHE=0
DRY_RUN=0
FORCE=0

DEFAULT_EXCLUDES=(
  '.DS_Store'
  '*/.DS_Store'
  '*/node_modules/*'
  '*/.npm/*'
  '*/.cache/*'
  '*/.local/*'
  '*/.plugin-manager/*'
  '*/__pycache__/*'
  '*.pyc'
  '*.log'
  '*/session.lock'
  '*.tmp'
  '*.bak'
  '*.fixed'
  '*.swp'
  '*~'
)

usage() {
  cat <<EOF
用法:
  $PROG export [-d DIR] [-o FILE] [--include-secrets] [--include-projcache] [--exclude GLOB] [-n]
  $PROG inspect ARCHIVE
  $PROG import ARCHIVE [-d DIR] [--force] [-n]

说明:
  export   过滤并打包 DATA_DIR，归档含 manifest.json / SHA256SUMS / RESTORE.txt / payload/
  inspect  查看归档摘要(不落地 payload)
  import   校验并恢复到目标 DATA_DIR；默认拒绝覆盖已有数据，--force 才覆盖同名文件

参数:
  -d, --data-dir DIR   指定 DATA_DIR；缺省依次取环境变量 DATA_DIR、仓库 .env、./data
  -o, --output FILE    输出归档路径；缺省 ./dsh-migration-<时间>.tar.gz
      --include-secrets          携带鉴权壳 auth-password/auth-secret(会迁移旧登录态；dsh 的 .credentials.yaml 始终携带)
      --include-projcache        携带 session_projcache(预设 id 改过时可能过期)
      --exclude GLOB             追加排除规则(对相对路径做 bash glob 匹配)，可重复
      --force                    允许覆盖目标同名文件(不会删除目标已有文件)
  -n, --dry-run         只报告将处理的文件，不写归档/不落盘

过滤说明:
  默认排除 npm/pnpm 缓存、node_modules、插件管理器日志、__pycache__、*.log、
  *.tmp、*.bak、*.fixed、*.swp、编辑器交换文件与 .DS_Store。
  会话事件流、profile 配置、附件、workspace 与自定义预设默认保留。
EOF
}

log()  { printf '[migrate] %s\n' "$*" >&2; }
warn() { printf '[migrate] 警告: %s\n' "$*" >&2; }
die()  { printf '[migrate] 错误: %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [ -n "$STAGE" ] && [ -d "$STAGE" ]; then
    case "$STAGE" in
      /tmp/*|"${TMPDIR:-/tmp}"/*) rm -rf "$STAGE" ;;
    esac
  fi
}
trap cleanup EXIT

need_arg() {
  [ "$#" -ge 2 ] || die "$1 缺少参数"
}

env_data_dir() {
  local envfile="$SCRIPT_DIR/.env" line val
  [ -f "$envfile" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    case "$line" in DATA_DIR=*) val="${line#DATA_DIR=}" ;; *) continue ;; esac
    val="${val%%#*}"
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    val="${val%\"}"; val="${val#\"}"
    val="${val%\'}"; val="${val#\'}"
    [ -n "$val" ] && { printf '%s' "$val"; return 0; }
  done < "$envfile"
  return 0
}

resolve_dir() {
  local d="$1"
  case "$d" in /*) ;; *) d="$SCRIPT_DIR/$d" ;; esac
  if [ -d "$d" ]; then (cd "$d" && pwd -P); else printf '%s' "$d"; fi
}

pick_data_dir() {
  local raw="$1"
  if [ -z "$raw" ]; then raw="${DATA_DIR:-}"; fi
  if [ -z "$raw" ]; then raw="$(env_data_dir)"; fi
  if [ -z "$raw" ]; then raw="./data"; fi
  resolve_dir "$raw"
}

if command -v shasum >/dev/null 2>&1; then
  hash_file()  { shasum -a 256 "$1"; }
  check_hashes() { (cd "$1" && shasum -a 256 -c "$2"); }
elif command -v sha256sum >/dev/null 2>&1; then
  hash_file()  { sha256sum "$1"; }
  check_hashes() { (cd "$1" && sha256sum -c "$2"); }
else
  die "找不到 shasum 或 sha256sum，无法生成校验和"
fi

is_excluded() {
  local rel="$1" pat
  case "$rel" in
    dsh/*|workspace/*) ;;
    *) return 0 ;;
  esac
  case "$rel" in
    dsh/auth-password|dsh/auth-secret)
      [ "$INCLUDE_SECRETS" -eq 1 ] || return 0
      ;;
    dsh/.dsh/storages/session_projcache/*)
      [ "$INCLUDE_PROJCACHE" -eq 1 ] || return 0
      ;;
  esac
  for pat in "${DEFAULT_EXCLUDES[@]}" "${EXTRA_EXCLUDES[@]:-}"; do
    [ -n "$pat" ] || continue
    [[ "$rel" == $pat ]] && return 0
  done
  return 1
}

cmd_export() {
  local data_opt="" output="" raw
  EXTRA_EXCLUDES=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -d|--data-dir) need_arg "$@"; data_opt="$2"; shift 2 ;;
      -o|--output)   need_arg "$@"; output="$2"; shift 2 ;;
      --include-secrets)   INCLUDE_SECRETS=1; shift ;;
      --include-projcache) INCLUDE_PROJCACHE=1; shift ;;
      --exclude) need_arg "$@"; EXTRA_EXCLUDES+=("$2"); shift 2 ;;
      -n|--dry-run) DRY_RUN=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "未知参数: $1" ;;
    esac
  done

  raw="$data_opt"
  local dir; dir="$(pick_data_dir "$raw")"
  [ -d "$dir/dsh" ] || die "DATA_DIR 下没有 dsh/: $dir"

  STAGE="$(mktemp -d "${TMPDIR:-/tmp}/wb-migrate.XXXXXX")"
  mkdir -p "$STAGE/payload/dsh" "$STAGE/payload/workspace"
  : > "$STAGE/filelist"

  local sub path rel
  for sub in dsh workspace; do
    [ -e "$dir/$sub" ] || continue
    while IFS= read -r path; do
      rel="${path#"$dir"/}"
      is_excluded "$rel" || printf '%s\n' "$rel" >> "$STAGE/filelist"
    done < <(find "$dir/$sub" -type f -o -type l)
  done

  local count bytes
  count="$(wc -l < "$STAGE/filelist" | tr -d ' ')"
  bytes="$(python3 - "$dir" "$STAGE/filelist" <<'PY'
import os, sys
root, listing = sys.argv[1], sys.argv[2]
total = 0
for rel in open(listing, encoding='utf-8').read().splitlines():
    try:
        total += os.path.getsize(os.path.join(root, rel))
    except OSError:
        pass
print(total)
PY
)"
  log "DATA_DIR: $dir"
  log "待打包: $count 个文件, $((bytes / 1024)) KB"

  if [ "$DRY_RUN" -eq 1 ]; then
    log "dry-run: 以下是将保留的文件(最多 30 条)"
    sed -n '1,30p' "$STAGE/filelist" >&2
    [ "$count" -le 30 ] || log "... 其余 $((count - 30)) 个文件省略"
    return 0
  fi

  while IFS= read -r rel; do
    mkdir -p "$STAGE/payload/$(dirname "$rel")"
    cp -RpP "$dir/$rel" "$STAGE/payload/$rel" || die "复制失败: $rel"
  done < "$STAGE/filelist"

  printf '%s\n' "${DEFAULT_EXCLUDES[@]}" > "$STAGE/excludes.txt"
  : > "$STAGE/extra-excludes.txt"
  if [ "${#EXTRA_EXCLUDES[@]}" -gt 0 ]; then
    printf '%s\n' "${EXTRA_EXCLUDES[@]}" >> "$STAGE/excludes.txt"
    printf '%s\n' "${EXTRA_EXCLUDES[@]}" >> "$STAGE/extra-excludes.txt"
  fi

  python3 - "$STAGE" "$dir" "$count" "$bytes" "$INCLUDE_SECRETS" "$INCLUDE_PROJCACHE" <<'PY'
import json, os, socket, sys, datetime
stage, root, count, size, secrets, projcache = sys.argv[1:7]
def read_lines(name):
    p = os.path.join(stage, name)
    if not os.path.exists(p):
        return []
    return [line for line in open(p, encoding='utf-8').read().splitlines() if line]

ex = read_lines('excludes.txt')
extra_ex = read_lines('extra-excludes.txt')
manifest = {
    'format': 'ownspire-dsh-migration',
    'version': 1,
    'createdAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'source': {'dataDir': root, 'host': socket.gethostname()},
    'options': {
        'includeSecrets': secrets == '1',
        'includeProjectionCache': projcache == '1',
        'extraExcludes': extra_ex,
    },
    'excludedPatterns': ex,
    'contents': {'files': int(count), 'bytes': int(size), 'payloadRoot': 'payload'},
    'notes': [
        'payload/dsh 与 payload/workspace 对应容器内 /data/dsh 与 /data/workspace',
        '默认不含 auth-password/auth-secret，恢复后密码从容器日志重新生成',
        '默认不含 session_projcache，会话打开时会从事件流重建投影',
        'payload 含 dsh/.dsh/.credentials.yaml(API key/浏览器会话 secret)，归档需按密码文件保管',
    ],
}
with open(os.path.join(stage, 'manifest.json'), 'w', encoding='utf-8') as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
PY

  cat > "$STAGE/RESTORE.txt" <<EOF
ownspire-raven 数据迁移包 — 恢复说明
====================================
1. 把本归档拷到新电脑，解压或直接执行：
     ./migrate.sh inspect <归档>
     ./migrate.sh import <归档> -d <新 DATA_DIR>
2. 在仓库 .env 里写 DATA_DIR=<新 DATA_DIR>，按需设置 BIND_IP / HOST_PORT / AUTH_PASSWORD。
3. docker compose up -d --build
4. 若未携带 secrets：从 docker logs workbench 取首次生成的登录密码；
   旧浏览器 Cookie 因签名密钥不同需要重新登录。
5. 若改过自定义预设 id：旧会话可能报 Unknown agent preset。
   参考 .workbuddy/memory/MEMORY.md「容器部署的已知边界」处理。

安全提示：payload 内含 dsh/.dsh/.credentials.yaml(模型 API key、浏览器会话 secret)，
归档等同密码文件，请加密保存、不要发到公开渠道。

注意：明文 HTTP 只适合可信局域网；跨公网请套 Tailscale 或 HTTPS。
EOF

  (cd "$STAGE" && while IFS= read -r rel; do hash_file "payload/$rel"; done < filelist) > "$STAGE/SHA256SUMS"

  [ -n "$output" ] || output="$PWD/dsh-migration-$(date +%Y%m%d-%H%M%S).tar.gz"
  case "$output" in /*) ;; *) output="$PWD/$output" ;; esac
  [ ! -e "$output" ] || die "输出文件已存在，不覆盖: $output"

  tar -czf "$output" -C "$STAGE" manifest.json SHA256SUMS RESTORE.txt payload
  log "已生成: $output"
  log "查看摘要: $PROG inspect \"$output\""
}

cmd_inspect() {
  local archive="${1:-}"
  [ -n "$archive" ] && [ -f "$archive" ] || die "用法: $PROG inspect ARCHIVE"
  tar -tzf "$archive" >/dev/null 2>&1 || die "无法读取归档(不是有效 tar.gz): $archive"
  echo '=== manifest ==='
  tar -xzOf "$archive" manifest.json | python3 -m json.tool
  echo '=== payload 文件数 ==='
  tar -tzf "$archive" | grep -c '^payload/' || true
  echo '=== 恢复说明 ==='
  tar -xzOf "$archive" RESTORE.txt 2>/dev/null || log '(归档内无 RESTORE.txt)'
}

cmd_import() {
  local archive="${1:-}"
  [ -n "$archive" ] && [ -f "$archive" ] || die "用法: $PROG import ARCHIVE [-d DIR] [--force] [-n]"
  shift
  local data_opt=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -d|--data-dir) need_arg "$@"; data_opt="$2"; shift 2 ;;
      --force) FORCE=1; shift ;;
      -n|--dry-run) DRY_RUN=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "未知参数: $1" ;;
    esac
  done

  STAGE="$(mktemp -d "${TMPDIR:-/tmp}/wb-migrate.XXXXXX")"
  mkdir -p "$STAGE/extract"
  tar -xzf "$archive" -C "$STAGE/extract" || die "解压失败: $archive"
  [ -f "$STAGE/extract/manifest.json" ] || die "归档缺少 manifest.json"
  [ -f "$STAGE/extract/payload/dsh" ] || [ -d "$STAGE/extract/payload/dsh" ] || die "归档缺少 payload/dsh"

  local version
  version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$STAGE/extract/manifest.json")"
  [ "$version" = "1" ] || die "不支持的归档版本: $version"

  if [ -f "$STAGE/extract/SHA256SUMS" ]; then
    check_hashes "$STAGE/extract" "$STAGE/extract/SHA256SUMS" >/dev/null || die "校验和验证失败，归档可能已损坏"
    log "校验和验证通过"
  else
    warn "归档无 SHA256SUMS，跳过完整性校验"
  fi

  local target; target="$(pick_data_dir "$data_opt")"
  local existing=0
  if [ -e "$target/dsh" ] || [ -e "$target/workspace" ]; then
    existing="$(find "$target/dsh" "$target/workspace" -type f 2>/dev/null | wc -l | tr -d ' ')"
  fi
  local incoming
  incoming="$(find "$STAGE/extract/payload" -type f | wc -l | tr -d ' ')"
  log "目标 DATA_DIR: $target"
  log "归档文件数: $incoming; 目标已有文件数: $existing"

  if [ "$DRY_RUN" -eq 1 ]; then
    log "dry-run: 不写入任何文件"
    return 0
  fi

  if [ "$existing" -gt 0 ] && [ "$FORCE" -eq 0 ]; then
    die "目标目录已有数据。请换一个空目录，或显式加 --force(只覆盖同名文件，不删除已有文件)"
  fi
  [ "$existing" -eq 0 ] || warn "--force: 将覆盖同名文件；不会删除目标已有文件"

  mkdir -p "$target"
  tar -cf - -C "$STAGE/extract/payload" . | tar -xf - -C "$target"
  log "恢复完成"
  log "下一步: 在 .env 里设置 DATA_DIR=${target}，然后 docker compose up -d --build"
  log "登录密码(未携带 secrets 时)见 docker logs workbench"
}

cmd="${1:-}"
[ "$#" -gt 0 ] && shift
case "$cmd" in
  export)  cmd_export "$@" ;;
  inspect) cmd_inspect "$@" ;;
  import)  cmd_import "$@" ;;
  *) usage; exit 1 ;;
esac
