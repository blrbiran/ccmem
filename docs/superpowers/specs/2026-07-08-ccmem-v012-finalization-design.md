# ccmem v0.12 finalization design

> 日期：2026-07-08  
> 状态：approved in conversation, pending written-spec review  
> 范围：实现并收口 `docs/ccmem-v0.12-spec.md` 与 `docs/ccmem-v0.12-dogfood.md` 对应的 v0.12 最终落地态  
> 方法：按能力分层增量落地，先 schema 与观测，再功能与文档收口

---

## 1. 背景与目标

当前仓库里的 v0.12 相关信息分散在两类文档中：

- `docs/ccmem-v0.12-spec.md`：定义了 v0.12 原始实施目标，主题是“检索硬化 + 可观测性优先，小功能增量其次”
- `docs/ccmem-v0.12-dogfood.md`：记录了实现后的多轮评审、真实 dogfood、以及对 live DB 升级链问题的校正

本次工作不是“按最早 spec 机械补代码”，而是**把 v0.12 收口到 dogfood 校正后的最终落地态**。用户已明确确认两点：

1. **范围基线**：以 `ccmem-v0.12-spec.md` 为主，并纳入 dogfood 中已确认应回补到 v0.12 的 P0/P1 缺口；defer/P2 项只在最终 review 中列明，不自动扩 scope
2. **完成态定义**：允许加入 `015_v012_repair` / schema 15，把 live DB 升级链上的已确认 P0 一并收口；并同步更新代码与文档

因此，本次设计的目标是：

> **用最小必要改动，把 v0.12 的 schema、检索观测、熔断、benchmark、temporal tag、structured summary、query cache、upgrade repair、测试和文档一起收口到一致状态。**

---

## 2. 范围锁定

### 2.1 纳入本次的能力

本次纳入以下能力与修复：

1. **Schema / upgrade chain**
   - 正式 v0.12 migration（014）
   - live DB 半截 014 的幂等修补 migration（015 repair）
   - migration runner 对 repair migration 的同步执行能力

2. **P1.2 retrieval observability**
   - `retrieval_path` 四态：`A` / `B-off` / `B-fail` / `B-circuit`
   - `retrieval_embed_error`、`retrieval_fallback`
   - `metrics_daily_rollup` 中的 embed error rate 与 path 分布
   - `diagnose --retrieval` 对观测数据的消费

3. **P1.1 embedding circuit breaker**
   - 失败计数
   - open / half-open / close 语义
   - 基于 `config_kv` 的持久化状态
   - audit 记录与 diagnose 可见性

4. **P1.3 retrieval benchmark**
   - `ccmem admin retrieval-check`
   - 默认 corpus
   - recall/precision 输出
   - last-run audit 与 diagnose 摘要

5. **P2.1 / P2.2 / P2.3 三项增量能力**
   - temporal tag
   - structured session summary / `summary_meta`
   - query embedding cache

6. **代码与文档同步**
   - 更新 `docs/ccmem-v0.12-spec.md`
   - 更新 `docs/ccmem-v0.12-dogfood.md`
   - 实现后做逐条对照 review

### 2.2 不纳入本次的内容

以下内容不主动纳入本次实现，只在最终 review 中显式标明：

- dogfood 中已 defer 的 P2 打磨项
- v0.13 方向的扩展能力，如更重的 benchmark 扩展、额外检索演进、体系化重构
- 与 v0.12 收口无直接关系的命令体系或 retrieval 算法重写

### 2.3 成功标准

本次完成定义分四层：

1. **代码层**：spec + 已确认 dogfood P0/P1 条目真实接线，不接受 wired-but-inert
2. **测试层**：关键链路有端到端验证，尤其是 migration、summary、temporal、retrieval telemetry、circuit breaker
3. **文档层**：spec 与 dogfood 文档反映最终落地状态，而不是保留过期中间态
4. **review 层**：最终给出逐条对照结果，明确哪些已完成、哪些 defer、哪些仍需真实 infra dogfood

---

## 3. 方案比较与选型

### 3.1 方案 A：按能力分层增量落地

顺序：schema/repair → observability → circuit breaker → benchmark → temporal/summary/cache → docs/review

优点：
- 风险最低
- 能先打通基础升级链与观测，再叠功能
- 最容易定位回归和 inert 接线问题
- 符合当前仓库“surgical changes”原则

缺点：
- 改动面分布在多个文件
- 需要较多针对性测试补齐

### 3.2 方案 B：按 dogfood finding 逐条回填

优点：
- 对真实问题贴合度高
- 便于直接消灭已知缺口

缺点：
- 实现顺序受历史 finding 驱动，不够整齐
- 容易遗漏 spec 中未被 finding 直接点名但仍应落地的链路

### 3.3 方案 C：按模块整体重做 v0.12 面

优点：
- 模块边界看起来更统一

缺点：
- 超出“最小必要改动”
- 回归风险最高
- 不适合当前以收口为主的任务

### 3.4 结论

选择 **方案 A：按能力分层增量落地**。

原因不是它最“优雅”，而是它最符合本次任务的真实目标：**以最低 blast radius 把 v0.12 收口到 dogfood 校正后的最终态，并且每一步都可验证。**

---

## 4. 分阶段实施设计

### 阶段 A：先补 schema 与升级链

目标：让后续所有 v0.12 代码都建立在正确 schema 之上，而不是边写边假设列/表存在。

交付：
- `scripts/migrations/014_v012.sql`
- `scripts/migrations/015_v012_repair.cjs`
- `scripts/lib/db.mjs` 中 migration loader 扩展
- 对应 migration 测试

验收：
- fresh DB 从旧版本升级到最新时 schema 完整
- 历史“半截 014”数据库可被 015 幂等修复
- repair migration 重跑不报错、不重复污染数据

### 阶段 B：先做 P1.2，可观测性先于熔断

目标：先让 retrieval path、error、fallback、rollup、diagnose 形成可观测链路，再引入熔断逻辑。

交付：
- `retrieveMemories` 返回路径与 timing 扩展
- `prompt-submit` 透传 metrics 字段
- `metrics-rollup` 聚合 path 分布与 embed error rate
- `diagnose --retrieval` 展示新观测数据

验收：
- 四态 `A / B-off / B-fail / B-circuit` 都有明确输出
- metrics 与 rollup 中均能看到真实落地数据
- diagnose 不靠猜测重建状态，而是消费真实存储/审计数据

### 阶段 C：在观测链路上叠 P1.1 circuit breaker

目标：让 embedding 失败从“每次现试现挂”变为“有状态、可观测、可恢复”的降级链。

交付：
- `provider.mjs` 的 circuit gate 与 kv 状态管理
- `retrieval.mjs` 的 open / half-open / probe 行为
- open/close audit
- admin diagnose / control surface

验收：
- 连续失败能触发 OPEN
- OPEN 期间不再调用 embed
- half-open 探活成功后 CLOSE
- probe 失败不会无界累积 failures，也不会重复刷 open audit

### 阶段 D：补 benchmark 与三个增量功能

目标：补齐 v0.12 原本承诺的“定量基线 + 小功能增量”。

交付：
- `retrieval-check` 命令与默认 corpus（CLI + slash admin surface 同步可达）
- temporal tag 全链路
- structured summary / `summary_meta` 全链路（基于当前 `cmd/save.mjs` 写入面收口，不预设新写入模块）
- query embedding cache 与清理逻辑

验收：
- benchmark 可离线运行并写 last-run audit
- `summary_meta` 从 LLM 原始输出到 DB 列全链路生效
- `temporal_type='permanent'` 真正影响优先级排序
- query cache 命中/写入/并发/清理行为与 spec 一致

### 阶段 E：文档同步与最终 review

目标：让仓库呈现的状态和真实代码状态一致，并明确收口结果。

交付：
- 更新后的 `docs/ccmem-v0.12-spec.md`
- 更新后的 `docs/ccmem-v0.12-dogfood.md`
- 一份实现后逐条对照 review

验收：
- 文档不再描述仓库里不存在的中间态
- spec / dogfood / 代码 / 测试 四者的关系清晰

---

## 5. 文件级改动边界

本次只在与 v0.12 直接相关的文件附近动刀，不做横向重构。

### 5.1 Schema 与升级链

- `scripts/lib/db.mjs`
- `scripts/migrations/014_v012.sql`
- `scripts/migrations/015_v012_repair.cjs`
- 相关 migration 测试文件

### 5.2 Retrieval observability + circuit breaker

- `scripts/lib/retrieval.mjs`
- `scripts/lib/embedding/provider.mjs`
- `scripts/handlers/prompt-submit.mjs`
- `scripts/lib/metrics-rollup.mjs`
- `scripts/lib/admin/diagnose.mjs`

### 5.3 Retrieval benchmark

- `scripts/lib/admin/retrieval-check.mjs`
- `scripts/cli.mjs`
- `commands/admin.md`
- `scripts/lib/benchmark/corpus.json`
- 对应 command / diagnose 测试

> admin 命令面采用 **CLI + slash surface 同步更新**：实现落在 `scripts/cli.mjs` 与 `scripts/lib/admin/*.mjs`，用户入口通过现有 `commands/admin.md` 暴露；本次不新增新的 top-level command 文件，只补现有 admin surface。

### 5.4 Temporal / summary / cache

- `scripts/daemon/tasks/summarize-pending.mjs`
- `scripts/lib/llm-parse.mjs`
- `scripts/lib/cmd/save.mjs`（当前写入面；若后续证明有必要，再从现有写入路径抽 shared helper，而不是预设新建 `memory-write.mjs`）
- `scripts/daemon/tasks/weekly-synthesis.mjs`
- `scripts/lib/llm-prompts/weekly-synthesis-v2.mjs`
- `scripts/lib/injection-cache.mjs`
- `scripts/lib/priority.mjs`
- `scripts/daemon/tasks/daily-maintenance.mjs`

### 5.5 文档与 OpenWolf

- `docs/ccmem-v0.12-spec.md`
- `docs/ccmem-v0.12-dogfood.md`
- `.wolf/memory.md`
- `.wolf/cerebrum.md`
- `.wolf/buglog.json`（若本次出现修复或失败测试）
- `.wolf/anatomy.md`（如创建新文件）

---

## 6. 测试与验收设计

本次测试策略以**链路验证优先**为原则，避免只证明局部 helper 正确。

### 6.1 Migration / schema

至少覆盖三类场景：

1. **fresh upgrade**：从旧 migration 顺序升级到最新，断言 014/015 后 schema 完整
2. **partial-014 repair**：构造 `schema_meta=14` 但缺少 `summary_meta` / `query_embedding_cache` / rollup 新列的数据库，断言 015 正确修复
3. **idempotent repair**：同一数据库重复执行 repair，不应产生副作用

### 6.2 Retrieval telemetry + circuit breaker

至少覆盖：

- `A`
- `B-off`
- `B-fail`
- `B-circuit`
- metrics 字段真实落库/落日志
- rollup 聚合真实消费路径字段
- diagnose 展示 kv override、path 分布、benchmark last-run
- circuit breaker 的 open / half-open / close / repeated probe failure 行为

### 6.3 Benchmark

至少覆盖：

- 默认 corpus 与自定义 corpus
- `--k` 解析
- recall/precision 输出
- `retrieval_check_run` audit 写入
- 离线路径不触发联网 embedding

### 6.4 Temporal / summary / cache

至少覆盖：

- `summary_meta`：原始 LLM 输出 → parser → memory write → DB 列
- `temporal_type`：weekly synthesis 输出 → 存储 → injection/priority 消费
- query cache：命中、写入、模型失效、并发冲突安全、清理逻辑

### 6.5 最终验收

本次交付最终以三类结果收口：

1. **测试结果**：相关 targeted tests + 一轮更广回归
2. **文档对照**：逐条标注已实现 / defer / 需真实 infra dogfood
3. **仓库一致性**：spec、dogfood、代码、测试之间不再互相打架

另加一条运行时约束：本仓库 sqlite 相关的广义回归与最终验证应对齐 `/usr/local/bin/node`，避免出现“测试策略正确但运行时不一致”的假绿结果。

---

## 7. 风险与控制策略

### 7.1 主要风险

1. **schema 未先到位，代码先引用新列**
   - 结果：silent failure、写入跳过、生产与 fresh test DB 行为分裂

2. **helper 正确但链路 inert**
   - 结果：单测绿，但系统行为不变

3. **诊断面展示的是猜测，不是真实状态**
   - 结果：dogfood 期间误导排障

4. **文档继续保留中间态**
   - 结果：下次实现或 review 继续被旧叙述带偏

### 7.2 控制策略

1. **先 schema，后功能**
2. **每个关键字段都做端到端验证**
3. **dogfood truth 优先于过期 spec 文案**
4. **限制 blast radius，不做无关重构**
5. **实现后立即同步文档与 review 结果**

---

## 8. 非目标

本设计明确不追求以下目标：

- 借 v0.12 收口之机重构整个 retrieval 架构
- 引入 v0.13 才需要的数据模型或工具面
- 统一清理全部历史技术债
- 为未来假设需求预留额外抽象

本次工作的标准不是“把系统变得更漂亮”，而是：

> **用最小必要改动，收口 v0.12 的真实承诺，并让 spec、dogfood、代码、测试重新对齐。**
