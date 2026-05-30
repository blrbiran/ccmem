# ccmem v0.1 + v0.2 implementation design

> 日期：2026-05-30  
> 状态：approved in conversation, pending written-spec review  
> 范围：实现 `docs/ccmem-v0.1-spec.md` 与 `docs/ccmem-v0.2-spec.md` 对应代码  
> 方法：vertical slicing，单代码库分层退化

---

## 1. 背景与目标

ccmem 的长期设计、v0.1 实施 spec、v0.2 实施 spec 已经足够详细；本文件**不重复业务规则与 schema 细节**，只回答一件事：

> **如何把 v0.1 与 v0.2 一起实现成一个可交付、可验证、可退化运行的 Claude Code plugin。**

本次实现已确认以下前提：

- **一次性交付 v0.1 + v0.2**，不做“先 ship v0.1、再过 1-2 周补 v0.2”的节奏
- **实施顺序采用 vertical slicing**，优先尽快跑通端到端链路，再向下补完整能力
- **运行时仍保留 spec 的分层退化语义**：Tier 1 / Tier 1.5 可在无 daemon 时工作，Tier 2 依赖 daemon
- **不重写 spec，不另立新规则**。所有行为细节、SQL、阈值、命令语义以 `docs/ccmem-v0.1-spec.md` 与 `docs/ccmem-v0.2-spec.md` 为准

本设计文件的作用是给实现阶段提供：

1. 目录结构与模块边界
2. 分阶段落地顺序
3. 运行时职责划分
4. 验收与回归守卫

---

## 2. 设计原则

### 2.1 单代码库，按 capability gate 分层

实现上不维护“两套系统”。统一代码库、统一 SQLite schema、统一命令面；差异通过显式 gate 表达：

- **v0.1 baseline**：基础 hook、命令、SQLite、FTS5、Tier 1 gate、cache regeneration
- **v0.2 Tier 1 / 1.5**：trust、feedback、recent_injections、Stop hook、lazy SQL maintenance
- **v0.2 Tier 2**：daemon、cron、`claude -p`、weekly synthesis、L4 review

这样做的理由：

- 避免 v0.1 / v0.2 各自维护一套入口与 shared lib
- 能在实现早期就把 schema、plugin packaging、CLI surface 一次定型
- 退化行为天然落在 capability gate 上，而不是靠分支堆积

### 2.2 vertical slicing 优于水平分层施工

实施顺序以“尽快形成可运行链路”为目标，而不是先把所有基础设施写完再集成。

每个 slice 都必须形成一个用户可验证的闭环，例如：

- `save -> list -> SessionStart inject`
- `save -> prompt retrieval`
- `Stop -> enqueue -> daemon consume`

这样能更早发现：

- schema 设计与调用面不一致
- plugin packaging 约束落地有坑
- LLM-safe 输出约束与真实 CLI 行为不一致
- hook 预算超标

### 2.3 严格遵守现有 spec 的运行时边界

本实现不会引入额外设计抽象。尤其保持以下边界不变：

- **Hook** 只做同步 SQLite I/O、轻量渲染、JSON stdout 输出、metrics
- **Command** 是用户入口与 shared façade，slash/CLI 共享 `scripts/lib/cmd/*.mjs`
- **Daemon** 是唯一允许 `claude -p` / cron / 长耗时工作的地方

任何偏离以上边界的实现都视为 spec drift。

---

## 3. 目标目录结构

```text
ccmem/
├── .claude-plugin/
│   └── plugin.json
├── bin/
│   └── ccmem
├── commands/
│   ├── list.md
│   ├── show.md
│   ├── save.md
│   ├── forget.md
│   ├── pin.md
│   ├── mode.md
│   ├── audit.md
│   ├── stats.md
│   ├── promote.md
│   ├── resurrect.md
│   └── admin.md
├── hooks/
│   └── hooks.json
├── scripts/
│   ├── cli.mjs
│   ├── hook.mjs
│   ├── handlers/
│   │   ├── session-start.mjs
│   │   ├── prompt-submit.mjs
│   │   └── stop.mjs
│   ├── daemon/
│   │   ├── main.mjs
│   │   ├── lock.mjs
│   │   ├── loop.mjs
│   │   ├── claude-p.mjs
│   │   ├── wake.mjs
│   │   └── tasks/
│   │       ├── summarize-pending.mjs
│   │       ├── daily-maintenance.mjs
│   │       └── weekly-synthesis.mjs
│   ├── lib/
│   │   ├── db.mjs
│   │   ├── config.mjs
│   │   ├── project-key.mjs
│   │   ├── mode.mjs
│   │   ├── hook-safety.mjs
│   │   ├── metrics.mjs
│   │   ├── render.mjs
│   │   ├── injection-cache.mjs
│   │   ├── threat-scan.mjs
│   │   ├── type-heuristic.mjs
│   │   ├── trust.mjs
│   │   ├── feedback.mjs
│   │   ├── priority.mjs
│   │   ├── recent-injections.mjs
│   │   ├── tier15.mjs
│   │   ├── task-runs.mjs
│   │   ├── version-gate.mjs
│   │   ├── transcript.mjs
│   │   ├── admin/
│   │   │   ├── daemon.mjs
│   │   │   ├── cron.mjs
│   │   │   └── diagnose.mjs
│   │   └── cmd/
│   │       ├── list.mjs
│   │       ├── show.mjs
│   │       ├── save.mjs
│   │       ├── forget.mjs
│   │       ├── pin.mjs
│   │       ├── mode.mjs
│   │       ├── audit.mjs
│   │       ├── stats.mjs
│   │       ├── promote.mjs
│   │       ├── resurrect.mjs
│   │       └── admin.mjs
│   └── migrations/
│       ├── 001_initial.sql
│       └── 002_v02.sql
├── config.default.json
└── package.json
```

### 3.1 目录级约束

- `.claude-plugin/` 下只放 `plugin.json`
- `commands/`、`hooks/`、`scripts/` 都放在 plugin root
- slash command 的 `.md` 文件统一配置 `command: true` 与 `disable-model-invocation: true`
- hook command 使用 `${CLAUDE_PLUGIN_ROOT}`；slash command 走 PATH 上的 `ccmem` CLI

---

## 4. 模块边界

### 4.1 基础设施层

- `db.mjs`：打开 DB、WAL、busy_timeout、migration、data root 路径
- `config.mjs`：defaults < user < project < runtime 四层 merge
- `project-key.mjs`：从 git remote / fallback 路径归一 project key
- `mode.mjs`：active / shadow / off 读写
- `metrics.mjs`：hook 与 daemon 的轻量 metrics append

这些模块必须先稳定，因为后续 hook / command / daemon 都依赖它们。

### 4.2 注入与检索层

- `render.mjs`：稳定上下文块与检索结果块渲染
- `injection-cache.mjs`：从 `memories` 重建 `injection_cache`
- `type-heuristic.mjs`：`save` 默认 type 推断
- `threat-scan.mjs`：Tier 1 与 v0.2 Tier 2 gate

### 4.3 hook 层

- `session-start.mjs`：只读稳定 cache；v0.2 时附加 `recent_injections(session_start)`
- `prompt-submit.mjs`：FTS5 + LIKE fallback 检索；v0.2 时附加 L1 与 feedback placeholder
- `stop.mjs`：仅 v0.2，负责 enqueue summarize、L2、L2.5、wake daemon

### 4.4 command 层

所有命令逻辑都放在 `scripts/lib/cmd/*.mjs`。入口壳层只负责：

- 参数解析
- 调用具体 `cmd<Verb>`
- 格式化输出
- 返回正确 exit code

命令层还承担 v0.2 的 Tier 1.5 prelude：在 `list/show/stats/save/resurrect/promote` 等命令前机会式执行纯 SQL maintenance。

### 4.5 daemon 层

daemon 子系统分为 4 类职责：

1. **生命周期**：单实例锁、心跳、launchd 安装/状态
2. **调度**：adaptive loop、wake file、task dispatch、retry
3. **LLM bridge**：`claude -p` 串行 semaphore、防递归
4. **任务实现**：summarize / daily maintenance / weekly synthesis

---

## 5. 实施阶段

### Phase 1: foundation

目标：建立能被后续所有 slice 复用的稳定骨架。

交付：

- `package.json`
- `.claude-plugin/plugin.json`
- `config.default.json`
- `scripts/lib/db.mjs`
- `scripts/lib/config.mjs`
- `scripts/lib/project-key.mjs`
- `scripts/lib/mode.mjs`
- `scripts/lib/hook-safety.mjs`
- `scripts/lib/metrics.mjs`
- `scripts/migrations/001_initial.sql`

验收：

- 能创建/打开 `~/.claude/ccmem/global.db`
- migration 001 可自动应用
- mode 可读写
- project key 可在 git repo 与非 git 路径下稳定返回

### Phase 2: minimal working path

目标：最短闭环 `save -> list -> SessionStart inject`。

交付：

- `scripts/hook.mjs`
- `scripts/cli.mjs`
- `scripts/handlers/session-start.mjs`
- `scripts/lib/render.mjs`
- `scripts/lib/injection-cache.mjs`
- `scripts/lib/threat-scan.mjs`（至少 Tier 1 save gate）
- `scripts/lib/type-heuristic.mjs`
- `scripts/lib/cmd/save.mjs`
- `scripts/lib/cmd/list.mjs`
- `commands/save.md`
- `commands/list.md`
- `hooks/hooks.json`（先只注册 SessionStart）
- `bin/ccmem`

验收：

- `ccmem save` 能写入 memory
- `ccmem list` 能列出 memory
- save 后自动重建 `injection_cache`
- SessionStart 从 cache 输出稳定上下文

### Phase 3: complete v0.1 surface

目标：完成 v0.1 hook + command 面，保持 hook 纯同步。

交付：

- `scripts/handlers/prompt-submit.mjs`
- `scripts/lib/version-gate.mjs`
- `scripts/lib/cmd/show.mjs`
- `scripts/lib/cmd/forget.mjs`
- `scripts/lib/cmd/pin.mjs`
- `scripts/lib/cmd/mode.mjs`
- `scripts/lib/cmd/audit.mjs`
- 其余 v0.1 slash command `.md`
- `hooks/hooks.json` 注册 UserPromptSubmit

验收：

- FTS5 + LIKE fallback 正常工作
- `show/forget/pin/mode/audit` 语义正确
- stdout / stderr 满足 LLM-safe 约束
- hook 失败时 exit 0，不阻塞主会话

### Phase 4: v0.2 Tier 1 / 1.5

目标：在不依赖 daemon 的前提下接入 trust、feedback、recent_injections、Stop hook。

交付：

- `scripts/migrations/002_v02.sql`
- `scripts/lib/trust.mjs`
- `scripts/lib/priority.mjs`
- `scripts/lib/feedback.mjs`
- `scripts/lib/recent-injections.mjs`
- `scripts/lib/tier15.mjs`
- `scripts/lib/task-runs.mjs`
- `scripts/lib/transcript.mjs`
- `scripts/handlers/stop.mjs`
- 更新 `session-start.mjs` / `prompt-submit.mjs` 以写 v0.2 表
- `hooks/hooks.json` 注册 Stop

验收：

- 002 migration 能从 v1 升到 v2
- recent_injections / memory_feedback / session_context 可写
- L1 / L2 / L2.5 可在无 daemon 时运行
- Tier 1.5 命令 prelude 可在无 daemon 时维持基本卫生

### Phase 5: daemon + Tier 2

目标：补上 daemon、cron 与所有 `claude -p` 路径。

交付：

- `scripts/daemon/main.mjs`
- `scripts/daemon/lock.mjs`
- `scripts/daemon/loop.mjs`
- `scripts/daemon/claude-p.mjs`
- `scripts/daemon/wake.mjs`
- `scripts/daemon/tasks/summarize-pending.mjs`
- `scripts/daemon/tasks/daily-maintenance.mjs`
- `scripts/daemon/tasks/weekly-synthesis.mjs`
- `scripts/lib/admin/daemon.mjs`
- `scripts/lib/admin/cron.mjs`
- `scripts/lib/admin/diagnose.mjs`
- `scripts/lib/cmd/stats.mjs`
- `scripts/lib/cmd/promote.mjs`
- `scripts/lib/cmd/resurrect.mjs`
- `scripts/lib/cmd/admin.mjs`

验收：

- daemon 单实例锁正常
- Stop hook 写 wake file 能唤醒 daemon
- summarize / daily / weekly 三类任务能被调度并更新状态
- daemon down 时 `stats` 能准确反映退化状态

### Phase 6: polish + regression proof

目标：把“能跑”提升到“可维护、可回归验证”。

交付：

- 高价值单元测试
- 关键集成测试
- manifest / packaging regression checks
- grep-based implementation guardrails
- hook 性能验证

验收：

- 核心链路测试可重复通过
- packaging 与 hooks 注册方式符合 Claude plugin 实际约束
- hook budget 不明显超 spec

---

## 6. 运行时数据流

### 6.1 SessionStart

数据流：

`hook input -> resolveProjectKey -> read injection_cache(global + project) -> render -> stdout JSON`

v0.2 only：

- mode != shadow 时写 `recent_injections(session_start)`
- 注入后跑 mini-prelude（只允许纯 SQL）

### 6.2 UserPromptSubmit

数据流：

`prompt -> sanitize -> FTS5 -> LIKE fallback -> dedupe -> renderRetrievedBlock -> stdout JSON`

v0.2 only：

- 写 `recent_injections(user_prompt_submit)`
- 写 `memory_feedback(outcome='unknown')`
- 对上一轮 `user_prompt_submit` 做 L1 行级归因

### 6.3 Stop

数据流：

`transcript -> parse stats -> write session_context -> enqueue summarize_pending -> infer L2/L2.5 -> touch wake file`

Stop hook 永不注入上下文，只负责写入与唤醒。

### 6.4 写路径与 cache invalidation

以下命令必须在成功写 `memories` 后同步重建相关 cache：

- `save`
- `forget`
- `pin`
- `promote`
- `resurrect`
- weekly synthesis（daemon）
- daily maintenance（如果影响 active set）

原则：**hook 只读 cache，不现算 stable context**。

### 6.5 daemon 任务路径

- `summarize_pending`：消费 Stop 入队任务，提取候选记忆
- `daily_maintenance`：纯 SQL，处理 decay / archive / cleanup / cache refresh
- `weekly_synthesis`：调用 `claude -p`，输出 consolidated / rule，并执行 L4 review

关键不变量：

> `await callClaudeP()` 上下不允许持有 SQLite transaction。

---

## 7. 验证策略

### 7.1 单元测试

优先覆盖纯函数与高漂移风险模块：

- `type-heuristic.mjs`
- `threat-scan.mjs`
- `sanitizeFtsQuery()` 与 LIKE fallback helper
- `computePriority()` / `adjustTrust()`
- `version-gate.mjs`
- `task-runs.mjs`

### 7.2 集成测试

必须覆盖以下端到端链路：

1. `save -> list -> SessionStart`
2. `save -> prompt-submit retrieval`
3. `forget/pin -> cache rebuild`
4. `migration 001 -> 002`
5. `Stop -> task enqueue -> daemon consume`

### 7.3 性能验证

性能验证不追求复杂 benchmark，只对照 spec 预算：

- SessionStart：`ms_business` / `ms_total`
- UserPromptSubmit：`ms_business` / `ms_total`
- Stop：确认不会显著拖慢回合结束

### 7.4 grep-based 守卫

以下检查作为实现边界保护：

- `scripts/handlers/` 不得出现 `spawn|exec|fetch|claude -p`
- v0.1 hot path 不得静默写 trust / feedback / daemon-only 表
- `await callClaudeP()` 附近不得出现 transaction begin/commit 持有跨越
- `commands/*.md` 必须显式 `command: true`
- `commands/*.md` 必须显式 `disable-model-invocation: true`
- 用户可见字符串必须使用 English

---

## 8. 完成定义

### 8.1 工程完成

以下内容全部存在并连通：

- plugin manifest
- hooks
- slash commands
- CLI
- SQLite schema + migrations
- shared libs
- daemon
- admin / stats / promote / resurrect 命令

### 8.2 行为完成

本地真实跑通以下行为：

- `save/list/show/forget/pin/mode/audit`
- SessionStart 注入
- UserPromptSubmit 检索注入
- Stop enqueue + daemon wake
- daemon 状态查询与 Tier 退化展示

### 8.3 非目标

本次实现**不额外扩 scope**：

- 不补 v0.3 及以后能力
- 不引入 embedding / sqlite-vec
- 不引入 Linux systemd / Windows scheduler
- 不新增 spec 未定义的 UX 流程
- 不为了“代码更优雅”重构 spec 已经明确的模块分工

---

## 9. 风险与对应策略

### 风险 1：plugin packaging 与官方文档不完全一致

应对：以现有 spec 中已验证结论为准；尽早落地最小 plugin skeleton，并做 regression check。

### 风险 2：同步 `DatabaseSync` 与 hook timeout 紧张

应对：优先完成最短路径，尽早记录 metrics；任何重活不放进 hook。

### 风险 3：v0.2 写路径过早污染 v0.1 baseline

应对：用 capability gate + grep 守卫 + slice 验收，确保 v0.1 baseline 先独立站稳。

### 风险 4：daemon 失败导致系统价值感模糊

应对：`stats` 必须清晰显示 Tier 1 / 1.5 / 2 当前状态，让退化是可见而不是静默的。

---

## 10. 实施结论

本项目的实现策略已经确定为：

- **一次性交付 v0.1 + v0.2 代码**
- **按 vertical slicing 分阶段落地**
- **统一代码库，按 capability gate 分层退化**
- **以 spec 为行为 SSOT，本文件只作为实现路线图**

下一步不再讨论设计，而是基于本文件生成 implementation plan，然后进入编码。
