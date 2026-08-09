# hook embed 的冷启动开销（~220ms/次，占 800ms 预算的 28%）—— 诊断 spec

> 2026-08-10。**这是 spec 不是 plan** —— 方案有三条，选哪条需要人类裁决。
> 上游证据链在 `docs/handoff/handoff.md` Ⅺ。**本文档只写已实测的东西和还没测的东西。**

## 问题陈述

`ccmem` 的 `UserPromptSubmit` hook **每个 prompt 都是一个全新的 node 进程**，
因此每次查询嵌入都要**重新做一次完整的 TLS 握手**。而常驻 daemon 不需要。

实测（handoff Ⅺ.5，COLD/WARM 交替，n=15/臂）：

| | p50 | min | max |
|---|---|---|---|
| COLD（每次调用新起进程 = hook 的形状） | **546** | 378 | 705 |
| WARM（同一进程第 2+ 次 = daemon 的形状） | **322** | 164 | 499 |

**差值 224ms。** 判别器：父进程自己的第一次调用 463ms，落在 COLD 一侧 ⇒ **效应来自进程内热度**。

## 这 224ms 的构成（实测，无 API 调用，2026-08-10）

新起进程，对 `api.openai.com` 连续建立四条连接，分相计时（毫秒）：

```
conn#1 (cold)         dns  5.3   tcp 1.1   tls 168.4   total 174.8   sessionReused=false
conn#2 (no session)   dns  2.3   tcp 0.7   tls 236.6   total 239.6   sessionReused=false
conn#3 (reuse #1)     dns  2.1   tcp 0.7   tls 162.5   total 165.3   sessionReused=false
conn#4 (reuse #1)     dns  2.0   tcp 1.2   tls 242.4   total 245.6   sessionReused=false
```

⇒ **成本几乎全在 TLS 握手（162–242ms）。DNS 2–5ms、TCP ~1ms，可忽略。**
握手区间与 COLD−WARM 的 224ms **量级完全吻合**。

### 为什么 daemon 在 5–7 分钟间隔下还是热的（此前未解释的疑点，现已自洽）

undici 的 `keepAliveMaxTimeout` 默认 **600s**；探针的采样间隔实测 p10 **300s** / p50 **420s**
⇒ **多数探针请求落在连接池仍然存活的窗口内**，所以探针拿到的是 WARM 量级（p50 357 ≈ WARM 322）。
这条同时说明：**只要请求间隔短于连接池窗口，常驻进程就能持续摊掉握手。**

## 🔴 未测的事（不要当成已排除）

- **TLS 会话恢复是否可行，未判定。** 上面四次全是 `sessionReused=false`，**包括显式传入 session 的两次**，
  但这**不构成排除**：TLS 1.3 的 NewSessionTicket 在握手**之后**才发，
  在 `secureConnect` 当场调 `getSession()` 很可能取到空票。
  ⇒ **要判定必须改成监听 `session` 事件后再取票重测。** 方案 2 在此之前是"未知"，不是"不行"。
- **daemon 连接池的实际存活窗口未直接测**（600s 是 undici 默认值，服务端可能给更短的 hint）。
- **COLD 546 与 hook 实测 673 之间还有 ~127ms 未解释**（约 12ms 是 `retrieval.mjs:384-389` 里
  那两次同步 SQLite 写，其余推测是 prompt-submit 时刻的本机竞争，**未取证**）。

## 三条方案

### 方案 1：hook 的 embed 走常驻 daemon

hook 把 prompt 文本交给 daemon，daemon 用它已经热着的连接池做嵌入并回传向量。

- **收益**：省掉全部握手，hook 侧中位从 ~546 降到 ~322。**这是唯一有实测支撑的方案**
  （探针就是活证据：常驻进程在真实采样节奏下确实拿到 WARM 量级）。
- **代价 / 风险**：
  - 新增一个 IPC 面（本仓库目前没有 hook↔daemon 的同步 IPC 通道）。
  - **daemon 不在时必须优雅回落到今天的直连路径** —— 不能让 hook 依赖 daemon 存活。
  - hook 是同步为主的进程，IPC 要选不会把 5000ms harness 硬限吃掉的形式。
  - ⚠️ **把 prompt 文本交给另一个进程**，需要确认与 Ⅵ.4（凭据不进 daemon 环境）等既有裁决不冲突。

### ~~方案 2：跨进程复用 TLS 会话票~~ 🔴 **2026-08-10 已排除**

**重测结论：服务器根本不下发 NewSessionTicket。** 本文档上一版把它标成"未判定"，理由是首次测量在
`secureConnect` 当场取票、可能取空 —— **那个解释是错的**。两种方法都重测过：

| 测法 | 结果 |
|---|---|
| 手工包 `net` socket，监听 `session` 事件，等 400ms | `ticket=NONE`，cold TLS 220.2ms |
| **plain `tls.connect`，监听 `session` 事件，等 1500ms** | **`proto=TLSv1.3`，`ticket=NONE`**，cold TLS 169.2ms |

⚠️ **局限**：今天、这台机器、这个 endpoint 的观测，**不是永久属性**；两次都是单次试验（但两法一致）。
⇒ **本方案不再是候选。下面原文保留，仅为留住"为什么曾经考虑它"。**

~~跨进程复用 TLS 会话票~~

把 session ticket 落到数据根下，新进程启动时带票握手。

- **收益**：不改架构，hook 保持独立可用。
- **风险 / 未知**：**可行性未判定**（见上）。且票有有效期、要处理失效回落、
  **落盘的票是敏感物**（能被用来恢复会话），与"不落盘凭据"的既有纪律需要一起裁。

### 方案 3：不做结构改动，靠方案 A（抬超时）吸收

- **收益**：零风险，已在做。
- **代价**：那 224ms 每个 prompt 都在烧，占 800ms 预算的 28%、占抬高后 1200ms 的 19%。

## 建议的裁决顺序

1. **先把方案 2 的可行性问死**（便宜：改成监听 `session` 事件重测一次，几分钟）。
   它若可行，是代价最小的路；不可行就干净地划掉，不留悬念。
2. **方案 1 的裁决点不是"值不值"，而是"愿不愿意让 hook 依赖 daemon"** ——
   收益已经确定（~200ms/次），成本是一个新的 IPC 面和一条必须无条件可用的回落路径。
3. **无论选哪条，都不阻塞方案 A**（抬超时已在 `docs/superpowers/plans/2026-08-10-raise-openai-timeout.md`）。
   A 是止血 + 取数，B 是攻因，两者不冲突。

⚠️ **不要在方案 1/2 落地前重跑 A 的测量** —— 它们会改变 embed 延迟分布，
让 A 的预登记窗口不可比（Ⅴ：写进文档的任何计数都必须来自单一冻结快照）。
