# ADR-0001 · OpenClaw 的集成定位与边界

**状态**:已采纳 ｜ **日期**:2026-10-10

## 背景

ownspire 要在一台云主机上部署 [OpenClaw](https://github.com/openclaw/openclaw)
(前 Moltbot/Clawdbot):开源、local-first 的个人 AI 助理网关——Node 常驻 24/7,
接 Telegram / Discord / 企业微信 / 个人微信(腾讯官方插件 `@tencent-weixin/openclaw-weixin`)
等通道,自带心跳、cron(Automations)、技能与记忆。

需要裁定的四件事:

1. OpenClaw 在 ownspire 里是什么身份?和 little-one 什么关系?
2. raven「管理」它,管理的边界画在哪?
3. 任务分发 / 定时任务,调度器放哪边?
4. 结果怎么到手机?

## 决策

### 一、OpenClaw 是第三位「常驻公民」,不进 little-one 的引擎轴

用归属判据审:claude-cli 是**被逐轮驱动的 loop**,契合 little-one 的 Driver 接口;
OpenClaw 是**常驻网关**——自己长着通道触发器、心跳和 cron,驱动模型是「事件来了自己醒」。
把它接成 little-one 的第二种引擎,等于为它的形态发明一套没人需要的「网关会话契约」。

**两者零耦合。**little-one 服务 raven 界面的对话,OpenClaw 服务消息软件里的对话;
坏了互不牵连,little-one 甚至不需要知道它存在。

### 二、raven 管理面 = 一份服务定义,不新造管理子系统

OpenClaw 对 raven 来说只是「一个会被探针盯着、有几个按钮的常驻服务」,与 atlas 无本质区别。
注册表写一份定义,三件事各归其位:

| 层 | 内容 | 落点 |
|---|---|---|
| 进程层 | 重启 / 升级 | `actions` → scripts runner 预定义脚本(`openclaw-restart` / `openclaw-upgrade`) |
| 观测层 | 存活 / 内存 / 日志 | `probes` + `metrics` 采集;日志目录只读挂进 files manager |
| 对话层 | **不做** | 对话发生在 Telegram / 微信,不进 raven UI |

⚠️ **actions 的执行前提**:scripts runner 在 raven 进程里跑命令,所以这套方案要求
raven 跑在宿主机(pm2,现状)。**raven 搬进容器的日子里,升级动作降级为宿主机手动,
不挂 docker.sock** —— 那等于把宿主机 root 交给一个带公网消息通道的服务。

### 三、不反代 OpenClaw 的 Control UI

它有自己的控制台。反代进 raven 同源 = 双登录体系(PIN vs 它自己的鉴权)混在一起,
等于给 PIN 门后面开一条绕过 raven 治理的直通道。深度管理(改配置、设通道)走内网 / VPN
直接访问它;raven UI 只做上表三层。

### 四、调度住在 OpenClaw;raven 调度器缓议

OpenClaw 的 **Automations** 就是内建调度器:任务持久化、断电恢复、到点唤醒 agent、
输出可投递到聊天通道或 webhook。它已经把这件事做完了。

- 任务定义写在 OpenClaw 的 Automations 里,raven **零新代码**
- 手动分发的最小形态:dashboard 上一个 action 按钮,点了 POST OpenClaw 的 webhook
- **raven 调度器缓议**。触发条件:任务多到「散在 OpenClaw 里找不到」成为真实痛点。
  届时 raven 新增 schedules 表(cron + 动作 + payload + 执行历史),并接下调度器的
  全部责任:错过触发追跑还是跳过、上一轮未完成的并发策略、失败重试、时区 ——
  每一条都要显式裁定。**在攒够真实任务之前凭空设计调度器,设计的一定是用不上的东西。**

### 五、结果到手机 = OpenClaw 的通道本身,不自建推送

通道(微信 / Telegram)就是推送通道。raven 脚本跑完 → 结果经 OpenClaw 发到手机,
不需要 APNs、不需要自建推送服务。可选的存档回路:OpenClaw 出站 webhook 接
raven 已有的 ingest 模式(registrationToken 那套)。

### 六、业务数据的门:raven 的 MCP 端点

OpenClaw 想碰剪贴板 / todo 等业务数据,走 `/api/agent/mcp`(raven 的 MCP 端点,
与 claude 引擎同一扇治理门)——而不是它自己裸奔的 shell。**第三位公民也过同一扇治理门。**
此项为演进项:先让它用自己的技能跑稳,再挂 MCP。

## 被否的备选

| 备选 | 否决理由 |
|---|---|
| 接成 little-one 的第二种引擎 | 驱动模型不匹配(常驻事件驱动 vs 逐轮调用);为它发明网关会话契约不值得 |
| raven BFF 转发 OpenClaw 控制 API | 在 raven 里养第二套 agent 契约;两套凭据、两套事件形状 |
| 反代 Control UI 进 raven | 见决策三:绕过治理的后门 |
| raven 立刻实现调度器 | 决策四:OpenClaw Automations 已覆盖;调度器责任的四条裁定没有真实任务支撑 |
| 自建推送(APNs / 长连接) | 通道即推送;OpenClaw 的存在让这层彻底多余 |

## 后果

**正**:raven 零新代码(一份服务定义 + 两条脚本);OpenClaw 保持完全独立,升级与
故障半径互不波及;业务数据访问天然过治理门。

**负**(明说的代价,不是遗漏):

- 任务定义散在 OpenClaw 的配置里,没有集中视图 —— 由决策四的触发条件兜底
- OpenClaw 升级可能破坏只读集成(探针 / 日志路径)—— **容忍**,它不是治理关键路径;
  这与 little-one「契约冻结、按 code 分支」的紧集成姿态刻意不同:管理对象不需要契约
- 状态卷(记忆 + 通道凭据 + 模型 key)进云主机备份策略,备份本身要加密

## 开放问题

- 通道选型:企业微信 Bot 模式(官方 API,最稳)先行,个人微信腾讯官方插件
  (`@tencent-weixin/openclaw-weixin`,能力元数据未完整声明)作为给自己用的补充,
  上线前验证消息覆盖面
- 云主机位置与微信回调连通性:若在境外,企业微信回调链路需先验证
  (腾讯云指南直接建议国内服务器)
