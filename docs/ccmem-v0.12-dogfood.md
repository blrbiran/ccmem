# ccmem v0.12 Dogfood 文档

> 验证 v0.12「检索硬化 + 可观测性优先，小功能增量其次」实现是否符合 spec。
> 本文档由**第三轮 llmfusion 多模型评审**（2026-06-24，Opus + Sonnet + Haiku panel + Fable Judge）产出，
> 评审范围对照 [`ccmem-design.md`](./ccmem-design.md)（长期 SSOT）与 [`ccmem-v0.12-spec.md`](./ccmem-v0.12-spec.md)（实施 spec）。
> 评审方法：3 个 panelist 独立读码 + Judge 交叉验证 + 主循环逐条对代码复核确认。
>
> **背景**：v0.12 实现已通过 1123 测试 + 附录 A grep 不变量 105–119。前两轮 fusion review 已修复
> 8 个 P0（含 `effectiveHalfLifeDays` 接线但 SELECT 缺 `temporal_type`、cache-hit 调 `recordEmbedSuccess`、
> `getProviderWithCircuit` 调 `loadConfig()` 等"wired-but-inert"类问题）。本轮目标是找**下一批**测试覆盖不到的同类问题。

---

## 一、v0.12 实现状态

| 能力 | 状态 | 关键文件 |
|---|---|---|
| P1.2 retrieval 四态可观测性 | ✅ ship | `retrieval.mjs`、`prompt-submit.mjs`、`metrics-rollup.mjs` |
| P1.1 embedding 熔断 | ✅ ship | `embedding/provider.mjs`、`retrieval.mjs`、`diagnose.mjs`（`diagnose --embedding-circuit`） |
| P1.3 retrieval benchmark | ✅ ship（seed corpus / per-lane defer） | `admin/retrieval-check.mjs`、`benchmark/corpus.json`、`diagnose.mjs`(--retrieval) |
| P2.1 temporal tag | ✅ ship（real-infra 标注质量待 dogfood） | `priority.mjs`、`injection-cache.mjs`、`weekly-synthesis-v2.mjs` |
| P2.2 结构化 session summary | ✅ ship | `summarize-pending.mjs`、`cmd/save.mjs`、`llm-parse.mjs` |
| P2.3 query embedding 缓存 | ✅ ship（hit-rate 观测 defer） | `retrieval.mjs`、`daily-maintenance.mjs` |

当前回归：351 pass / 0 fail（`/usr/local/bin/node --test tests/unit/*.test.mjs tests/integration/*.test.mjs`）。

---

## 二、Code Review 发现与修复（第三轮 fusion，2026-06-24）

> 严重度：**P0** = runtime-inert / 错误行为 / spec 违反；**P1** = 边界条件正确性风险；**P2** = 打磨 / 可观测性缺口。
> 所有发现已由主循环逐条 Read 源码复核确认（非仅转述 panel）。

### Finding 1：P2.2 `summary_meta` 在生产中恒为 NULL（CRITICAL / P0）

**现象**：`summarize_pending` 跑完后，`memories.summary_meta` 列始终为 NULL——P2.2 的 4 个结构化字段（investigated/learned/completed/next_steps）从未落库。

**根因**：`parseLlmJsonStrict` → `normalizeItems`（`scripts/lib/llm-parse.mjs:76-83`）用一个**显式白名单**构造 item 对象：
```javascript
return arr.map(it => ({
  content, type, scope, tags, source_ids, output_type,
})).filter(...)
```
白名单**不含** `investigated/learned/completed/next_steps`。LLM 即便输出了这 4 字段，也在 parser 层被丢弃。
`summarize-pending.mjs:134` `let { ok, items } = parseLlmJsonStrict(raw1, …)` 拿到的 `items` 已无这 4 字段 →
`:191` `buildSummaryMeta(it)` 读到的 `it.investigated` 等全是 `undefined` → 恒返回 `null`。

**为什么测试没抓到**：`tests/unit/v012-summary.test.mjs` 直接调 `buildSummaryMeta` / `insertMemory`，**绕过了 parser**，
所以 `summary_meta` 序列化逻辑本身是对的，但 parser→buildSummaryMeta 这条生产链路从未被 e2e 覆盖。
**与第二轮 fusion 抓到的 `effectiveHalfLifeDays` 接线但 SELECT 缺 `temporal_type` 完全同构**——"单元正确，链路 inert"。

**证据**：`scripts/lib/llm-parse.mjs:76-83`（白名单）、`:55-58`（parseLlmJsonStrict 调 normalizeItems）、
`scripts/daemon/tasks/summarize-pending.mjs:134`（取 items）、`:191`（buildSummaryMeta 调用）。

**修复**：在 `normalizeItems` 白名单补 4 字段透传（仅在字段存在时保留，做 maxLength 200 截断）；
新增 parser→buildSummaryMeta→insertMemory 的 e2e 测试（喂一个含 4 字段的 LLM 原始输出，断言 `summary_meta` 非 NULL）。

**验证状态**：✅ 已修复（commit `7e0a40a`，TDD：e2e 测试先 RED 后 GREEN；1126 tests pass）。

---

### Finding 2：`retrieval-check` 会销毁用户运行时 `embedding.enabled` 配置（HIGH / P0）

**现象**：用户若曾通过运行时 kv 开启过 embedding（`config_kv` 里 `embedding.enabled='true'`），
跑一次 `ccmem admin retrieval-check` 后，该 kv 被静默 DELETE，embedding 被悄悄关掉。

**根因**：`scripts/lib/admin/retrieval-check.mjs:54` 用 `readKvInt(db, 'embedding.enabled')` 读"保存值"以备恢复。
但 `readKvInt` 内部做 `Number(row.value)`——`Number('true')` 与 `Number('false')` 都是 `NaN`，
被 `Number.isFinite(n) ? n : null` 归零 → `savedKv` **恒为 `null`**（无论原值是 'true' 还是 'false'）。
于是 `finally`（`:104`）走 `if (savedKv === null) clearKv(db, 'embedding.enabled')` → **永远 DELETE**。

**证据**：`scripts/lib/admin/retrieval-check.mjs:54`（readKvInt 误用）、`:104-105`（恢复逻辑）；
当前 shipped branch 未抽出独立 kv helper module；等价的 kv 读取 helper 以内联函数形式存在于 `scripts/lib/embedding/provider.mjs`，其中数字读取仍对非数字字符串返回 null。

**修复**：不要用 `readKvInt` 读布尔/字符串 kv。内联 `SELECT value FROM config_kv WHERE key='embedding.enabled'` 取原始字符串，
`finally` 里按原始字符串 verbatim 恢复（`null` → `clearKv`，`'true'`/`'false'` → `writeKv` 原值）。

**验证状态**：✅ 已修复（commit `c037b3c`，TDD：'true' 存活 + 无残留两个回归测试；1128 tests pass）。

---

### Finding 3：`file_based===false` 降级路径 recordMetric 缺 3 个 retrieval 字段（MEDIUM / P1）

**现象**：v0.9 直注 `additionalContext` 的降级路径（`file_based!==true`）记的 metric 缺 `retrieval_path`/`retrieval_embed_error`/`retrieval_fallback`，
导致该模式下 `aggregateRetrievalPaths` 分桶遗漏、rollup 的 path 分布失真。

**根因**：实现时 `replace_all` 替换 `retrieval_pool: timing?.candidatePool,` 行，但该行在降级块里是 6 空格缩进、
另两处是 8 空格，精确匹配只命中 2/3 处。降级块（`:113-128`）的 `retrieval_pool`（`:124`）后直接跟 `additional_context_empty`，漏了 3 字段。

**证据**：`scripts/handlers/prompt-submit.mjs:113-128`（降级 recordMetric），对比 `:58-61` 与 `:99-101`（已补全）。
`:36-38` 的 `path`/`embedError`/`fallback` 变量在该作用域内可用，直接补即可。

**修复**：在 `:124` 后补 3 字段，与另两块一致。

**验证状态**：✅ 已修复（commit `0450a7e`，TDD：file_based=false 路径回传 retrieval_path=B-off 回归测试；1129 tests pass）。

---

### Finding 4：熔断 half-open 探活失败会无限累加 failures 并重复写 audit（MEDIUM / P1）

**现象**：熔断 open→half-open 后，若探活 embed 仍失败，`recordEmbedFailure` 会：① `failures` 计数继续 ++（3→4→5…无上限）；
② 因 `failures >= threshold` 每次都成立，每次探活失败都重写 `open_until` + 重发 `embedding_circuit_open` audit。
长期网络故障下 audit 日志被刷爆，`failures` 计数失真。

**根因**：`scripts/lib/embedding/provider.mjs:114-129` `recordEmbedFailure` 不区分"首次 trip"与"已 open 后的探活失败"。
（注：Panel B 曾称"success 会把 failures 重置为 0"——Judge 已驳斥：`recordEmbedSuccess` 不在 breaker open 路径上调用，前提错误。本 finding 以 Panel A 的"无界增长 + 重复 audit"为准。）

**修复**：`recordEmbedFailure` 在已 trip（`open_until` 非空，含 half-open 的过去时间戳）时，只刷新 `open_until`（重置 cooldown），
**不** ++ failures、**不** 重发 audit。closed 态的新失败仍正常累积、达阈值 trip 一次。

**验证状态**：✅ 已修复（commit `19470de`，TDD：probe-fail 不增长 failures + 不重发 audit + closed→threshold 仍 trip 一次；更新了原 codify 旧行为的测试；1131 tests pass）。

---

### Finding 5：`diagnose --retrieval` 的 Embedding enabled 标签撒谎（MEDIUM / P1）

**现象**：`diagnose --retrieval` 输出 `Embedding: enabled/disabled (provider)`，但读的是**文件 config**，
忽略 kv 运行时 override。用户用 `ccmem admin semantic on`（写 kv）关掉 embedding 后，diagnose 仍显示 enabled——
恰好在用户最需要真相的故障排查场景里误导。

**根因**：`scripts/lib/admin/diagnose.mjs:188,194` 用 `loadConfig().embedding.enabled`，未走 `getProvider` 的 kv-then-file 解析。

**修复**：镜像 `getProvider` 的解析逻辑（`readConfigKv('embedding.enabled')` 优先，回退 file config）输出真实启用状态。

**验证状态**：✅ 已修复（commit `3108ea8`，TDD：kv=false 覆盖 file=true + 无 kv 回退 file 两个测试；本 worktree closure run 为 351 tests / 0 fail）。

---

### Finding 6：benchmark 未达 spec 完成判据（MEDIUM / P1，spec §1.5 #12/#13）

**现象**：① 默认 corpus 仅 30 条，spec 要求 ≥100；② ~~`precision@K` 公式 = `recall@K / K`，数学错误~~
（**经主循环受控 corpus 实测复核：公式正确**——3 个非 adversarial 全 rank-1 命中时 precision@1=1.000、precision@3=0.333，
与 IR 教科书 `hits/(K·N)` 完全一致；对"每查询 1 相关项"corpus，`precision@K = recall@K/K` 是恒等式非错误。Judge 此条判定无效）；
③ 未输出"每路（FTS5 / Jaccard / cosine）及三路融合"的分别 recall——spec #13 要求 per-lane。

**根因**：实现按"seed ~30 + harness"决策（用户确认）先 ship 了 harness，corpus 与 per-lane 留待扩；
precision 公式经复核**无误**（Judge 误判）。

**证据**：`scripts/lib/benchmark/corpus.json`（30 条）、`scripts/lib/admin/retrieval-check.mjs:84-86`（precision 公式）。

**修复**：① corpus 扩到 ≥100（纯数据文件，不动代码）；② 修正 precision@K 公式；③ 加 per-lane recall（需 retrieveMemories 暴露每路候选，或在 benchmark 内分别跑 FTS5/Jaccard/cosine 单路）。

**验证状态**：
- ② **precision@K 公式正确，无需修**（受控 corpus 实测：precision@1=1.000、precision@3=0.333 = `hits/(K·N)`，与教科书一致；Judge 原判无效）。
- ① corpus 30<100：按既定决策保留，扩到 100 为后续数据任务。
- ③ per-lane recall：真实 spec 缺口（§1.5 #13），需 retrieveMemories 暴露每路候选——设计变更非 bug 修复，deferred 到 v0.13 候选。

---

### Finding 7–15：P2 打磨项（LOW）

| # | 文件:行 | 问题 | 修复 |
|---|---|---|---|
| 7 | `provider.mjs:101` | `last_probe_at` 在 dispatch 时戳记而非探活完成时——丢失的 probe 会被记成"刚探过" | 探活成功/失败后再戳 last_probe |
| 8 | `retrieval.mjs:65-85` | half-open 探活槽可被 cache hit 消耗（cache hit 不调 embed，却走了 half-open 分支），延迟恢复 | half-open 时跳过 cache 查询 |
| 9 | `retrieval.mjs:71-85` | cache INSERT 在 embed 的 try/catch 内——cache 写失败（磁盘满等）会被误判为 embed 失败、触发 recordEmbedFailure | cache 写单独 try/catch，不进 embed 错误路径 |
| 10 | `cmd/save.mjs` 写入链路 | dedup 的 content embed 调用绕过熔断门（try/catch 吞掉失败），熔断期内仍会尝试 embed | dedup embed 也走 getProviderWithCircuit |
| 11 | `weekly-synthesis.mjs:107-119,127` | `parseSynthesisOutput` + `applySynthesisResult` 已死代码（v0.8 inline 路径取代），且 `parseSynthesisOutput` 丢弃 `temporal_type` | 删除死代码，或补 temporal_type 透传 |
| 12 | `diagnose.mjs:148-154` | `embedding-circuit open` 手动命令不清 `last_probe_at`，可能残留导致半开判断错乱 | open 时一并 clear last_probe_at |
| 13 | `weekly-synthesis-v2.mjs:7,13` | `SYNTHESIS_V2_SCHEMA` 顶层缺 `additionalProperties:false`（item 级有） | 顶层补 |
| 14 | `summarize-pending.mjs:251-257` vs `:32-54` | prompt 说"仅 episode 类输出 4 字段"，但 schema 对所有 type 都 admit——LLM 可能在 rule/fact 上也输出，被 schema 接受 | 对齐 prompt 与 schema（要么 schema 限 episode，要么 prompt 放开） |
| 15 | `daily-maintenance.mjs:247` | cache 清理按 `created_at` 而非 `last hit`——高频命中的老缓存会被误清 | spec 允许（30d），可选优化按 last_hit |

**验证状态**（2026-06-24 处理：修 4，defer 5）：

| # | 处理 | commit / 理由 |
|---|---|---|
| 8 | ✅ 修 | `bc43765`：half-open 时跳过 cache，强制真探活（否则 cache hit 消耗探活槽、延迟恢复） |
| 9 | ✅ 修 | `bc43765`：cache INSERT 独立 try/catch，写失败不再误判 embed 失败 / trip 熔断 |
| 10 | ✅ 修 | `c42a68f`：dedup embed 走只读 `isCircuitTripped(db)`，熔断期跳过（不走 `getProviderWithCircuit` 以免 stamp last_probe 干扰 hook 探活节奏） |
| 13 | ✅ 修 | `b51ceab`：`SYNTHESIS_V2_SCHEMA` 顶层补 `additionalProperties:false`（item 级已有） |
| 7 | defer | 窄崩溃边（进程在 stamp last_probe 与探活完成间崩溃），跨函数重构，低价值 |
| 11 | defer | **非死代码**：`applySynthesisResult` 有专测（`weekly-synthesis-audit.test.mjs`）；temporal_type concern moot——活跃路径用 `parseRawLlmOutput`（保留 temporal_type），仅 legacy `parseSynthesisOutput` 丢弃且生产不调 |
| 12 | defer | **非真 bug**：`open` 已清 `open_until`；stale `last_probe_at` 在 open 期无害（future `open_until` 短路半开判断；stale 只让半开探活更早触发） |
| 14 | defer | 纯措辞：prompt 说"仅 episode"但 schema 全 type admit；LLM 在 rule/fact 上多输出 4 字段是无害存储（`buildSummaryMeta` 照存） |
| 15 | defer | spec 允许（30d 按 `created_at`）；按 `last_hit` 清理需加列（schema 变更），低价值 |

---

### 已验证 NOT bug（3/3 panel + Judge + 主循环一致）

- ✅ P2.1 temporal_type 端到端链路**运行时 active**：weekly-synthesis schema/prompt → insertMemory(`temporalType`) → storage → injection-cache SELECT（含 `temporal_type`）→ computePriority → effectiveHalfLifeDays。第二轮 fusion 修的 SELECT 缺列问题确实修好了。
- ✅ 不变量 #118c（`getProviderWithCircuit` 不调 `loadConfig()`）、#119（新文件用 `writeAudit` 非 `logAudit`）持住。
- ✅ `memories_fts` 仍只索引 `content`，`summary_meta` 不进 FTS5（triggers 在 001_initial.sql，014 未改）。
- ✅ B1（P2.3 WAL 并发前提）：`scripts/lib/db.mjs:31` `db.exec('PRAGMA journal_mode = WAL')` 确实设置——并发写入前提成立。

---

## 三、Dogfood 验证清单（运行时需手工验证，测试覆盖不到）

> 单元/集成测试用的是 mock provider 与 :memory: DB。下列项必须在**真实环境**验证。

### V1. 真实 embedding API 连续失败 → 熔断全流程
- [ ] 配置 openai provider + 一个会失败/超时的 endpoint（如 `openai_base_url=http://127.0.0.1:1`）
- [ ] 连发 3 个 prompt → 第 3 个后 `ccmem admin embedding-circuit status` 显示 OPEN
- [ ] OPEN 期间连发 prompt → `metrics.jsonl` 记 `retrieval_path:"B-circuit"`（**不是** `B-off`）、`retrieval_fallback:false`、且**不**调 embed（hook 延迟应 <200ms，对比 v0.11 Finding 10 的 1500ms 超时）
- [ ] 等 cooldown（5min）+ probe_interval（60s）→ status 显示 half-open → 一次成功 embed → status CLOSED + `embedding_circuit_close` audit
- [ ] **关注 Finding 4**：探活持续失败时，`failures` 是否无界增长？`embedding_circuit_open` audit 是否被刷屏？

### V2. 真实多窗口并发 → query cache 写冲突
- [ ] 开 2+ 个 Claude Code 窗口，同 prompt 同时提交
- [ ] `query_embedding_cache` 无 `UNIQUE constraint failed` 报错（INSERT OR IGNORE 兜底）
- [ ] `hit_count` 原子递增无误（WAL 模式下 `UPDATE … SET hit_count=hit_count+1` 不串改）
- [ ] **关注 Finding 8/9**：并发下 cache 写失败是否被误判为 embed 失败、触发熔断？

### V3. 真实 LLM weekly_synthesis → temporal_type 标注质量
- [ ] 跑一次 `ccmem admin cron run weekly_synthesis`（需 daemon 在线）
- [ ] 查 `SELECT id, content, temporal_type FROM memories WHERE type='consolidated' ORDER BY id DESC LIMIT 10`
- [ ] 验证：permanent 标注是否真的落在"永久性决策"上（如"项目用 pnpm"）、而非错标到临时事实上
- [ ] 验证：permanent 记忆在 `injection_cache` 排序中是否真的不被 recency 惩罚（对比同 trust 的 untagged 老记忆）
- [ ] **关注 Finding 11**：legacy `applySynthesisResult` 路径是否还会被触达？若被触达，temporal_type 是否丢失？

### V4. 真实 LLM summarize_pending → 4 结构化字段产出
- [ ] **Finding 1 已修**（commit `7e0a40a`）——`summary_meta` 现在会真正落库，本项可验证
- [ ] 跑完一个有实质内容的 session，触发 summarize_pending
- [ ] 查 `SELECT content, summary_meta FROM memories WHERE summary_meta IS NOT NULL`
- [ ] 验证 LLM 是否真的在 episode 类记忆上输出 investigated/learned/completed/next_steps（prompt 要求 vs LLM 实际遵从度）
- [ ] **关注 Finding 14**：rule/fact 类是否被 LLM 错误地附带 4 字段？schema 是否照单全收？

### V5. 离线 benchmark 对真实记忆库的 recall 基线
- [ ] `ccmem admin retrieval-check` 在装满真实记忆的库上跑
- [ ] 记录 recall@1/3/5 作为**v0.12 基线**（后续检索演进的对照）
- [ ] adversarial 报告：5/5 false-positive 是预期信号（trigram FTS5 对含常用词的离题 prompt 返回弱匹配）——验证这是 Path B 固有噪音、而非 bug
- [ ] **关注 Finding 6**：precision@K 数值是否明显异常（公式错误会导致 precision > recall 等怪象）；corpus 是否需扩到 100

### V6. `diagnose --retrieval` 真实故障排查可用性
- [ ] 模拟 embed 失败 → `diagnose --retrieval` 的 circuit 状态 / embed error rate / path 分布是否一致
- [ ] **关注 Finding 5**：若用 kv 运行时关了 embedding，diagnose 的 `Embedding: enabled/disabled` 标签是否撒谎？
- [ ] benchmark last-run 行是否正确从 `retrieval_check_run` audit 读取

### V7. 升级链兼容
- [ ] 在一个 v0.11 的真实 DB 上启动 v0.12 → migration 014 自动应用 → `diagnose --migrations` 显示 13→14
- [ ] 旧记忆的 `temporal_type`/`summary_meta` 均为 NULL（向后兼容）
- [ ] daemon self-restart 在 schema mismatch 时正确触发（v0.5 机制）

### V8. `additionalContext` 始终为空（v0.11 file-based 不变量）
- [ ] 正常 prompt 下 `metrics.jsonl` 的 `additional_context_empty:true` 仍恒成立
- [ ] context 文件仍写到 `.ccmem/context-{session_id[:8]}.md`，SessionStart 行为零变化

---

## 四、优先级建议

1. **✅ 已修**（原阻塞 dogfood）：Finding 1（P2.2 inert，`7e0a40a`）、Finding 2（销毁用户配置，`c037b3c`）——两个 P0 均已 TDD 修复，Finding 1 解除 V4 阻塞。
2. **✅ 已修**（原 dogfood 前修）：Finding 3（`0450a7e`）/4（`19470de`）/5（`3108ea8`）——三个 P1 均已 TDD 修复。
3. **dogfood 期间收集数据**：V1–V8 清单，重点是 V3（temporal 标注质量）与 V5（recall 基线）——这俩是 v0.13 检索演进的决策依据。
4. **后续**：Finding 6（corpus 扩到 100 + per-lane）、Finding 7–15（P2 打磨）。

---

> 本文档由 llmfusion 第三轮评审产出。RUN_DIR `/tmp/llmfusion.bOEkAO/`（panel-A/B/C.md + judge.md + judge-summary.md）为临时产物，已可清理。

---

## 五、Dogfood 验证结果（2026-06-24 实测）

> 由主循环按 §三 V1–V8 逐项实测，每项附命令证据。需要真实 infra（live OpenAI key / 运行中的 daemon LLM / 真·多窗口）的子项标注 🔶 blocked，并给出已验证的替代面。

### V1. 真实 embedding API 连续失败 → 熔断全流程 ✅
- 配置 openai provider + 拒连端口 `openai_base_url=http://127.0.0.1:1/v1` + `openai_timeout_ms:200` + 短 cooldown（`cooldown_ms:2000, probe_interval_ms:500`）。
- 连发 3 个 prompt：3 次全 `B-fail`，`embedCalls=3`，`circuit_open_until` 置位，`embedding_circuit_open` audit=1。
- OPEN 期第 4 个 prompt：`retrievalPath=B-circuit`、`embedCalls` 仍=3（**未尝试 embed**）、延迟 **0.1ms**（对比 v0.11 Finding 10 的 1500ms 超时）。
- Phase B half-open（手设 `open_until=过去` + `last_probe=0`）+ embed 成功：path=`A`、`embedCalls=4`、`open_until=null`（CLOSED）、`embedding_circuit_close` audit=1。
- 全量回归通过。

### V2. 真实多窗口并发 → query cache 写冲突 ✅（模拟 2 进程并发）
- 2 个 node 子进程（`child_process.spawn`）并发，各 10 轮 `INSERT OR IGNORE` 同 hash + `UPDATE hit_count+1`，WAL 文件 db + `busy_timeout=5000`。
- 两 worker 各 **0 errors**（无 UNIQUE constraint / SQLITE_BUSY）；最终 **1 行**（INSERT OR IGNORE 兜底）；`hit_count=21 = 1 + N·M`（**无丢失更新**——20 次并发 UPDATE 全部原子落地）。
- 🔶 真·多窗口 Claude Code 未跑（需多窗口环境）；并发安全机制（WAL + INSERT OR IGNORE + 单语句原子 UPDATE）已用真·多进程并发验证。
- Finding 8/9（cache 写失败被误判为 embed 失败）属另一代码路径，由 `v012-cache` 单测覆盖。

### V3. 真实 LLM weekly_synthesis → temporal_type 标注质量 ✅（非 LLM 链路）
- schema+prompt emit `temporal_type`（`weekly-synthesis-v2.mjs:18,64-71`）；insertMemory 写入链路带 `temporal_type`（`cmd/save.mjs`）；weekly-synthesis 两 callsite 传 `temporalType: syn.temporal_type ?? null`；injection-cache SELECT 带 `temporal_type` → computePriority → effectiveHalfLifeDays。
- 运行时单测「permanent memory outranks equal-decaying one」通过——链路 runtime-active。
- 🔶 真 LLM 标注质量（permanent 是否真的落在永久决策上）需 daemon + 真 LLM，未跑。

### V4. 真实 LLM summarize_pending → 4 结构化字段产出 ✅（合成 LLM 输出）
- 合成含 4 字段的 summarize LLM JSON → `parseLlmJsonStrict` → `buildSummaryMeta` → `insertMemory` → `summary_meta` 非 NULL，`learned`/`next_steps` 正确落库。
- FTS 找到 content 词 `rotation`、**不**找到 summary_meta-only 词 `collide`——content 是 FTS 单元，summary_meta 不泄漏。
- 🔶 真 LLM 是否在 episode 上输出 4 字段（遵从度）需 daemon + 真 LLM，未跑。Finding 1 已修，链路通畅。

### V5. 离线 benchmark recall 基线 ✅（+ 文档勘误）
- `ccmem admin retrieval-check`：recall@1=96.0% / @3=100.0% / @5=100.0%；5 adversarial / 5 false-positive（Path B 对含常用词离题 prompt 的固有噪音，预期信号）。
- `diagnose --retrieval` 从 `retrieval_check_run` audit 正确读 last-run。
- **文档勘误**：impl 用 fixture db（从 corpus seed）测 recall，**不**跑在真实记忆库上——dogfood V5「装满真实记忆的库上跑」的措辞与实现不符。recall@K 是相对 seed corpus 的，非用户真实记忆。已记入 Finding 6 跟进。

### V6. `diagnose --retrieval` 真实故障排查可用性 ✅
- `embedding-circuit open` → diagnose 显示 `circuit: OPEN`；benchmark 行 `recall@3 = 100.0% (last run 2026-06-24)` 从 audit 读取。
- **Finding 5 验证**：file config `embedding.enabled=true` (openai) + kv `embedding.enabled=false` → diagnose 正确显示 `Embedding: disabled (openai)`（kv override 生效，不再撒谎）。

### V7. 升级链兼容 ✅
- 构造 v0.11 schema-13 db（应用 001–013）→ 应用 014 → `schema_meta.version` 13→14；`schema_migrations` 新增 13→14 行。
- 旧记忆 `temporal_type=null` / `summary_meta=null`（向后兼容）；`query_embedding_cache` 表创建；`metrics_daily_rollup` 新增 `path_a_count` / `embed_error_rate` 列。

### V8. `additionalContext` 始终为空（v0.11 file-based 不变量）✅
- 真 hook 入口（`node scripts/hook.mjs prompt-submit` + stdin JSON）：`additionalContext: ''`、`additional_context_empty: true`。
- 写入路径由集成测 `file_based=true writes context-{session}.md, additionalContext empty` 覆盖（fresh pass：context 文件写入 + 检索 header + additionalContext 空）。

### 总结
- **8/8 V 项可测部分全部通过**，附命令证据。
- **3 项子项 🔶 blocked on real infra**：V3 真 LLM 标注质量、V4 真 LLM 4 字段遵从度、V2 真·多窗口。三者非 v0.12 代码正确性问题，需 dogfood 期真实 daemon+LLM/多窗口环境补验。
- **1 项文档勘误**：V5「真实记忆库」措辞与 fixture-db 实现不符，已记入 Finding 6。
- 当前本分支全量回归：351 tests / 0 fail（`/usr/local/bin/node --test tests/unit/*.test.mjs tests/integration/*.test.mjs`）。

## Closure checklist

- [x] Spec text matches shipped schema version and migration set
- [x] Dogfood text distinguishes fixed items from deferred items
- [x] Manual real-infra checks remain explicitly marked
- [x] No section still describes a separate memory-write module as shipped if the implementation stayed on `cmd/save.mjs`
- [x] Admin command surface matches `scripts/cli.mjs` + `commands/admin.md`

## Closure review

| bucket | items |
|---|---|
| implemented | schema 15 (`014_v012.sql` + `015_v012_repair.cjs`), retrieval four-state observability, kv-backed circuit breaker, retrieval-check command, summary_meta persistence, temporal tagging, query embedding cache + daily cleanup |
| deferred | benchmark corpus ≥100, per-lane benchmark recall, richer retrieval diagnose metrics, real `last_hit` cache eviction |
| needs real infra dogfood | true multi-window concurrency, true LLM temporal tag quality, true LLM structured summary adherence |

---

## 六、第四轮 fusion review（post-fix 复审，2026-06-24）

> 对本会话的 8 个 fix commit 做 panel+Judge 复审,确认 fix 本身无 P0/P1 回归,但抓到 fix 自身的 3 个缺口,已全部 TDD 修复。

| 发现 | 严重度 | 修复 | commit |
|---|---|---|---|
| P2-13 范围不完整:只硬化了 `weekly-synthesis-v2` 顶层,漏 item 级 ×2;且 `b51ceab` commit message 错称"item 级已有" | P2 | 补 item 级 `additionalProperties:false` | `6cba5cb` |
| 2 个兄弟 schema(`stale-check`、`contradiction-audit`)完全缺 `additionalProperties` | P1 | 补 top + item 级 | `6cba5cb` |
| P2-9 重构后 `recordEmbedSuccess(db)` 裸露在 try 外,瞬态 DB 错误会冒泡出 `retrieveMemories` | P2 | 包 best-effort try/catch | `14e032d` |

**共识(3/3 + Judge)**:8 个 fix 功能正确,无 P0/P1 回归;P1-4 half-open 判定正确;P2-10 TOCTOU 不成立;5 个 defer 全部 agree-defer。

**Judge 驳回的 panel 错误**:Panel B 称"item 级已有 `additionalProperties`"——经 HEAD 复核为假(从未有),Panel A/C 正确。

当前 worktree 全量回归：351/0（`/usr/local/bin/node --test tests/unit/*.test.mjs tests/integration/*.test.mjs`）。

---

## 七、Dogfood 实测 P0 发现（2026-06-25，real live DB 复核）

> 前六节均基于 fresh test DB + mock provider。本节是对用户 **real live `~/.claude/ccmem/global.db`**（schema_meta=14、daemon 活着、metrics.jsonl 218KB）的复核，暴露了 fresh-DB 测试覆盖不到的 **stale migration** 问题。

### Finding 16：historical live DB 命中过半 schema rollout——v0.12 四项 schema 改动只落地一项（CRITICAL / P0）

**现象**：live DB `schema_meta.version=14` 且 `schema_migrations` 记录 13→14 已应用，但实测四项 v0.12 schema 改动**只落地一项，且落地错**：

| v0.12 schema 对象 | live DB 实际 | spec/014 文件 |
|---|---|---|
| `memories.temporal_type` | ✅ 存在，但 `DEFAULT 'temporary'` + 多余索引 `idx_memories_temporal_type` | `TEXT`（NULL default，无索引）|
| `memories.summary_meta` | ❌ **列不存在** | `ALTER TABLE ... ADD COLUMN summary_meta TEXT` |
| `query_embedding_cache` 表 | ❌ **表不存在** | `CREATE TABLE query_embedding_cache (...)` |
| `metrics_daily_rollup` 5 新列（embed_error_rate / path_a_count / path_b_fail / path_b_off / path_b_circuit） | ❌ **全部不存在** | 5 条 `ALTER TABLE ... ADD COLUMN` |

且 `schema_migrations` 里 13→14 的 description 是 `"v0.12: temporal_type column + structured summary support"`，而当前 `014_v012.sql` 文件里是 `"v0.12: temporal_type + summary_meta + query_embedding_cache"`——**live DB 跑的是一份旧的/部分 RC 版 014**，文件后续被定稿，但 `runMigration` 见 13→14 已记录就跳过 → 缺的列永远不会补。

**直接后果（已发生）**：
- `summarize_pending` 自 **2026-06-24 10:42** 起每次 INSERT 都抛 `table memories has no column named summary_meta`，被 `summarize-pending.mjs:196` 的 try/catch 静默吞成 `summarize_insert_skip` audit（14 次，最近 3 次即此错误）。
- **v0.12 上线后零条新记忆入库**（`MAX(created_at)` = 2026-06-24 09:13:40，此后 0 条）。已静默丢记忆 ~31h。
- `summary_meta IS NOT NULL` = 0——**不是因为 LLM 没输出 4 字段，而是因为根本没 INSERT 成功**。Finding 1 的 parser 修复在生产从未生效。
- daemon.err.log 干净——错误只进 audit_log，不进 stderr，所以 `daemon status` 显示 healthy 误导。

**潜伏崩溃（未触发但必然）**：
- `retrieval.mjs` Path A 查 `query_embedding_cache` → 一旦开启 embedding 立即崩。
- `metrics-rollup.mjs` step 8（P1.2）写 `embed_error_rate`/`path_*` 列 → daily_maintenance 显示 completed，说明该 step 要么被 `embedding.enabled` 守卫跳过、要么被 try/catch 吞了（需复核，但当前 embedding=off 故未炸）。

**根因**：cerebrum 已记录同构模式——"code 引用 v0.12 columns 但 schema 没有"+"anatomy.md 曾列 014_v012.sql 不存在 on disk（spec 阶段 speculative 写的）"。v0.12 开发期 014 migration 文件晚于 code 落地，用户 live DB 在文件定稿前就跑了一份只含 temporal_type 的 interim 014，之后定稿文件因 migration guard 永不重跑。**fresh test DB 每次从头跑全套 migration（001–014），所以测试 100% 通过、V7 升级链 ✅——但真实升级路径（已应用过 interim 014）从未被测过**。

**修复（PROPOSED，未应用，待用户确认）**：新增 corrective migration `015_v012_repair.sql`，用 JS runner + `pragma_table_info` 守卫做幂等补建：
1. `ALTER TABLE memories ADD COLUMN summary_meta TEXT`（若缺）
2. `CREATE TABLE IF NOT EXISTS query_embedding_cache (...)` + `idx_qec_created`
3. `ALTER TABLE metrics_daily_rollup ADD COLUMN` 5 列（逐列 pragma 守卫）
4. （可选）`UPDATE memories SET temporal_type=NULL WHERE source<>'cron_consolidated'` 撤销错误的 DEFAULT 'temporary' 回填——让"NULL=未标注"不变量恢复，仅 weekly_synthesis/cron_consolidated 保留标注。
注：SQLite `ALTER ADD COLUMN` 无 `IF NOT EXISTS`，纯 SQL 不可重入，必须 JS 守卫。temporal_type 的 `DEFAULT 'temporary'` 无法直接移除（需重建表），靠 code 显式传值兜住（insertMemory 已显式 `validateTemporalType`），DEFAULT 仅影响历史回填行，故用 (4) 数据修正而非改 DDL。

**验证状态**：✅ **已修复（2026-06-25；本分支已对齐）**。新增 `scripts/migrations/015_v012_repair.cjs`（幂等 .cjs migration，pragma 守卫）+ 扩展 `scripts/lib/db.mjs` 同步加载 `.cjs` migration。015 补建 `summary_meta` 列 / `query_embedding_cache` 表 / `metrics_daily_rollup` 5 列，并把错误的 `'temporary'` 回填清为 NULL，最终 shipped schema 为 15。本 worktree 相关升级链与闭环回归已纳入当前 closure，当前全量为 351/0。**残余**：真 LLM 是否稳定输出 4 字段仍属于 real-infra dogfood，非这条 migration 修复本身。

---

> **本节是对 §五 V7「升级链兼容 ✅」的勘误**：V7 的 ✅ 只在 fresh test DB 成立；real live DB 的"已应用过 interim 014"路径会卡在半截 schema。Finding 16 已修复（015_repair），V7 现状为"fresh ✅ / 历史半截 ✅（经 015 修复）/ interim-014 检测需补 CI 守卫"。

### Finding 17：`ccmem save` 绕过 insertMemory → 新 save 仍吃 DEFAULT 'temporary'（LOW / P2）

**现象**：F4 验证时 `ccmem save` 插入的 #722 `temporal_type='temporary'`（非 NULL），尽管 F2 已把历史 606 条 'temporary' 清成 NULL。

**根因**：`scripts/lib/cmd/save.mjs:72` 用**自有 INSERT**（`db.prepare('INSERT INTO memories (scope, project_key, type, content, source, pinned, ...)')`），**绕过 `insertMemory`**。其列清单不含 `temporal_type`/`summary_meta` → live DB 列的 `DEFAULT 'temporary'`（interim-014 遗留，无法在不重建表前提下移除）对每个新 user_explicit save 生效。走 `insertMemory` 的路径（summarize_pending、weekly_synthesis）显式传 `temporal_type`，不受影响。

**影响**：行为无害（`'temporary'` = 正常衰减 = 与 NULL 在 `priority.mjs` 等价），但违反"NULL=untagged"不变量，且持续重新 defeating F2 cleanup。

**修复（PROPOSED，未应用，bug-100）**：把 `temporal_type` + `summary_meta` 加入 save.mjs INSERT 列清单并显式传 NULL（对齐 insertMemory）。2 行改动。或重建表移除 DEFAULT（过重，不做）。

**验证状态**：⏳ 未修复（P2，等用户确认是否纳入本次或推 v0.13）。
