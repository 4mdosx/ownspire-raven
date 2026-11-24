# Workbench — dsh 自托管工作台(阶段一)

自托管 AI 工作台的第一步:DeepSeek Harness(dsh)标准模式,承担日常聊天与
meta 层工作任务。设计文档见 `/Users/token/WorkBuddy/Claw/Workbench/DESIGN.md`。

## 快速启动

```bash
cp .env.example .env       # 填入 DEEPSEEK_API_KEY(可选,也可启动后在设置页填)
docker compose up -d --build
docker logs workbench | tail   # 取首次访问 URL(带 token)
```

浏览器打开日志里的 `http://127.0.0.1:3080/?token=...`。首次进入 Web UI →
设置 → 模型,填 DeepSeek API key(官方地址 `https://api.deepseek.com`)。
密钥持久化在挂载目录里,重建容器不丢。

## 架构

```
宿主 macOS
└── docker compose
    └── workbench 容器(node:24-slim,锁版本 @deepseek-ai/dsh)
        ├── HOME=/data/dsh        → dsh 配置 / 凭据 / 会话轨迹(~/.dsh)
        ├── WORKDIR=/data/workspace → agent 默认工作区
        └── dsh web 绑容器自身 IP:3080(dsh 拒绝绑 0.0.0.0,见下)
宿主挂载 ./data/ ← 以上两个目录;容器销毁重建,数据原样保留
```

**两个实测到的安全事实**(2026-11-24,dsh 0.2.2-rc.5):

1. dsh **明确拒绝绑 `0.0.0.0`**——官方防 RCE 设计,只接受具体地址。
   entrypoint 每次启动探测容器自身 IP(`hostname -I`)绑上去,Docker
   端口映射的 DNAT 流量目的地址就是它,天然兼容。容器重建 IP 变了也没关系,
   每次启动重新探测。
2. dsh web 自带访问 token,首次访问 URL 形如
   `http://127.0.0.1:3080/?token=...`,**在容器日志里**:
   `docker logs workbench | tail`。无 token 访问一律 401。

设计原则:**容器是无状态的,`./data/` 是唯一事实。** 升级 dsh 版本 =
改 compose/Dockerfile 里的版本号重新 build;升级前备份 `data/dsh/`
(会话轨迹是 append-only 事件流,是后续工厂审计的地基,丢了不可再生)。

## 目录

| 路径 | 说明 |
|---|---|
| `Dockerfile` | 镜像定义;版本锁在 ARG `DSH_VERSION` |
| `docker-compose.yml` | 端口 3080;挂载 `./data`;`restart: unless-stopped` |
| `docker-entrypoint.sh` | 首启建目录、选监听方式 |
| `.env.example` | `DEEPSEEK_API_KEY` 占位 |
| `data/` | 运行时数据(gitignore),宿主持有 |

## 升级与风险

- dsh 处于 developer preview,官方明示会有破坏性变更 → **版本锁死在
  Dockerfile,不追 latest**;升级前跑通一次冒烟(启动 + 发一条消息 + 会话可恢复)
- 会话轨迹、凭据都在 `./data/dsh/`;整机迁移 = 拷走这一个目录
- 插件启用前人工审核(DESIGN.md R2),一期默认不装任何社区插件

## 阶段一验收(DESIGN.md)

连续使用 7 天,聊天与至少 3 类工作任务(整理、检索、定时提醒)不回退到旧工具。
