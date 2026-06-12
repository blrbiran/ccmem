# ccmem v0.8 dogfood 文档

> 本文档记录 v0.8（Synthesis Maturity）实施后的验证结果、已知问题、以及 dogfood 期需要观察的行为。
>
> **当前状态（2026-06-05）**：实施完成，code review 完成（10 项 fix 已落地），待 dogfood。

---

## 一、v0.8 核心变更概览

| # | 能力 | 风险等级 | 说明 |
|---|---|---|---|
| A1 | 多后端 EmbeddingProvider（OpenAI + Jina） | 中 | 新增 2 个后端 + model-switch NULL + re-backfill |
| A2 | 输入管线净化（transcript cleaner + quality gate） | 中 | pre-LLM 噪音剥离 + post-LLM 质量门槛 |
| A3 | 整合管线重做（clusterBatchV2 + promptV2 + quality scoring） | 高 | weekly_synthesis 核心循环重写 |
| A4 | Contradiction merge（`m` 选项） | 中 | LLM 合并矛盾记忆，需用户 y/N 确认 |
| A5 | Synthesis 可观测性 | 低 | 5 个 rollup 列 + `--synthesis` diagnose + stats 行 |

---

## 二、实施后 code review 结果（2026-06-05）

**Reviewer**: oh-my-claudecode:code-reviewer (Opus)
**Verdict**: REQUEST CHANGES（3S + 5M + 5L）→ 全部修复后 937/937 pass

| # | 级别 | 问题 | 修复 |
|---|---|---|---|
| S1 | Significant | audit action 名称与 spec 不一致 + 缺 `weekly_synthesis_cluster_failed` | rename + 补 catch 内 audit — commit `2a7a6ff` |
| S2 | Significant | merged_duplicates UPDATE 漏 `last_touched_at` | 加到 UPDATE 语句 — commit `2a7a6ff` |
| S3 | Significant | `min_transcript_after_clean` fallback `?? 20` 应为 `?? 200` | 改 20→200 — commit `2a7a6ff` |
| M1 | Medium | v0.8 新代码路径用 `logAudit` 而非 `writeAudit` | 替换 4 处 — commit `2a7a6ff` |
| M3 | Medium | `cluster_threshold` 未从 config 删除 + 无 backward compat 映射 | 删旧 key + 加 fallback — commit `2a7a6ff` |
| M4 | Medium | `scoreSynthesisOutput` 就地 mutate + 双重截断 | 移除 scorer 内截断 — commit `2a7a6ff` |
| M5 | Medium | `getProvider(loadConfig())` 在 inner loop 重复调用 | hoist 到 loop 外 — commit `2a7a6ff` |
| L3 | Low | file_tree 规则末尾空格过宽 | 删空格 — commit `2a7a6ff` |
| L4 | Low | stale-check prompt 发 raw ts 而非 age_days | 对齐 spec — commit `2a7a6ff` |
| L5 | Low | merged_duplicates 截断 160 vs schema 300 | 改 160→300 — commit `2a7a6ff` |

**跳过项**（不影响功能）：
- M2: `--synthesis` 写 audit 与 `--tuning` 模式一致（keep）
- L1: 无 `embedding_api_error` audit（vec_backfill 已有 error audit，defer）
- L2: `parseLlmStructured` 与 `parseMergeResult` 重复（defer v0.9 统一）

**正面发现**：
- 架构集成安全：hooks 和 insertMemory 管线零改动
- clusterBatchV2 优雅降级（< 2 embeddings → v0.7 行为）
- 新 LLM prompt 全部含 S-4 防注入标记
- merge 有 y/N 确认门控 + DI 可测
- metrics-rollup INSERT 29 列 → 34 列对齐正确

---

## 三、测试状态

937/937 pass，0 fail。v0.7 baseline 857 → v0.8 新增 80 个测试。

| 类别 | 新增测试数 | 覆盖对象 |
|---|---|---|
| migration-009 | 8 | schema 升级 / CHECK enum / 幂等 |
| openai-embedding | 6 | 接口契约 / key 缺失 / isLoaded |
| jina-embedding | 6 | 接口契约 / key 缺失 / batch |
| model-switch | 10 | provider 路由 / NULL 逻辑 / 缓存 |
| transcript-cleaner | 11 | 各 rule / 混合内容 / 空输入 |
| quality-gate | 6 | too_short / commit_format / too_specific |
| cluster-batch-v2 | 9 | 两阶段聚类 / 降级 / maxSize |
| synthesis-quality | 8 | source_ids / 截断 |
| synthesis-prompts-v2 | 9 | STEP 1+2 / 无 stale / schema |
| merge-contradiction | 8 | prompt / schema / 菜单文案 |

---

## 四、dogfood 期需要验证的问题

### P0 — 必须在首日验证

#### V1: transcript cleaner 对真实 transcript 的效果

**验证方法**：
1. 等 daemon `summarize_pending` 处理几个会话
2. 检查 audit_log：`SELECT details FROM audit_log WHERE action='transcript_cleaned' ORDER BY ts DESC LIMIT 5`
3. 验证 `stripped_pct` 是否合理（预期 10-40%）
4. 验证 `rules_hit` 中哪些规则最常命中

**关注点**：
- [ ] diff/test/trace 块是否被正确剥离
- [ ] 自然语言对话是否被误剥（false positive）
- [ ] `stripped_pct` 是否有极端值（>80% 可能误杀）

#### V2: quality gate 拒绝率

**验证方法**：
1. 检查 audit_log：`SELECT json_extract(details,'$.reason') AS reason, COUNT(*) AS n FROM audit_log WHERE action='quality_gate_reject' GROUP BY reason`
2. 查看被拒绝的内容：`SELECT json_extract(details,'$.content_excerpt') FROM audit_log WHERE action='quality_gate_reject' ORDER BY ts DESC LIMIT 10`

**关注点**：
- [ ] 拒绝率是否合理（预期 5-30%）
- [ ] `too_short` 拒绝的内容是否确实是噪音
- [ ] `commit_format` 拒绝是否有误杀（合法 rule 被当成 commit message）
- [ ] `too_specific` 拒绝是否合理（路径占比 >50% 的判定）

#### V3: weekly_synthesis clusterBatchV2 效果

**验证方法**：
1. 等周日 03:17 weekly_synthesis 触发
2. 检查 audit_log：`SELECT json_extract(details,'$.synth_proposed') AS proposed, json_extract(details,'$.synth_accepted') AS accepted, json_extract(details,'$.synth_rejected') AS rejected, json_extract(details,'$.llm_calls') AS calls FROM audit_log WHERE action='weekly_synthesis_run' ORDER BY ts DESC LIMIT 1`
3. 对比 v0.7 的 synthesized=0 问题是否改善

**关注点**：
- [ ] `synth_proposed > 0`（v0.7 长期为 0，v0.8 目标是 > 0）
- [ ] `synth_accepted / synth_proposed` 比率（质量评分是否太严/太松）
- [ ] cluster 数量 vs LLM 调用数（是否合理分组）
- [ ] 是否出现 `weekly_synthesis_cluster_failed` audit（单 cluster LLM 失败）

### P1 — 首周验证

#### V4: 多后端 embedding 切换

**验证方法**：
1. 如有 OpenAI API key：`/ccmem:admin semantic on --provider openai`
2. 验证 `admin semantic status` 显示 `text-embedding-3-small / 1536-dim`
3. 检查 model-switch：`SELECT * FROM audit_log WHERE action='embedding_model_switched' ORDER BY ts DESC LIMIT 1`
4. 验证 `vec_backfill` 重新 embed：`/ccmem:admin cron run vec_backfill`
5. 切回 local：`/ccmem:admin semantic on --provider transformers-local`

**关注点**：
- [ ] model-switch 正确 NULL 旧 embedding（`nullified_count` 与实际 mem 数一致）
- [ ] 新模型 embed 的向量维度正确
- [ ] 切回 local 后检索行为恢复正常
- [ ] API key 缺失时的降级行为（`getProvider` 返回 null）

#### V5: contradiction merge 流程

**验证方法**：
1. 如有矛盾对：`/ccmem:resurrect --contradictions`
2. 测试 `m` 选项 → LLM 产出合并记忆 → `y/N` 确认
3. 验证新记忆 `type='consolidated'` + `parent_ids` 含两个 id
4. 验证原记忆 `status='superseded'`
5. 验证 alert `acknowledged_action='merged'`

**关注点**：
- [ ] LLM 合并质量（是否正确添加上下文而非发明内容）
- [ ] `merge_possible=false` 的 fallback 是否正常
- [ ] 合并后 lineage 可追溯（`parent_ids` 正确）

#### V6: `--synthesis` 诊断输出

**验证方法**：
1. 等积累 7+ 天数据后：`/ccmem:admin diagnose --synthesis`
2. 检查 3 段输出是否完整（input quality / weekly synthesis / output quality）

**关注点**：
- [ ] acceptance rate 是否有意义
- [ ] reject reasons 分布是否合理
- [ ] 无数据时是否友好提示（而非 crash）

### P2 — dogfood 期持续观察

#### V7: transcript cleaner false positive 率

**观察项**：
- [ ] 是否有用户对话内容被 `file_tree` 规则误剥（CJK 内容含 `│` 字符）
- [ ] `cli_output` 规则是否过宽（合法的 npm 相关讨论被剥）
- [ ] `stack_trace` 规则是否影响关于 error 处理的讨论

#### V8: quality gate 阈值调优

**观察项**：
- [ ] `min_chars=15` 是否太低/太高
- [ ] `too_specific` 的 50% 路径占比阈值是否合理
- [ ] 是否需要新增检查项（如"纯数字内容"、"重复的 test assertion"）

#### V9: clusterBatchV2 两阶段阈值

**观察项**：
- [ ] `cluster_tight_threshold=0.75` 是否产生足够多的紧密核心
- [ ] `cluster_loose_threshold=0.50` 是否让太多无关 mem 被归入核心
- [ ] misc cluster 大小分布（过大说明阈值太严，太多 mem 漏出核心）
- [ ] 与 v0.7 贪心单链接的对比：cluster 是否更紧凑

#### V10: merged_duplicates 实际产出

**观察项**：
- [ ] LLM 是否在 dedup 步骤产出 `merged_duplicates`（v0.7 无此步骤）
- [ ] 合并后的 content 质量（是否保留了关键信息）
- [ ] 被 supersede 的记忆是否确实是重复

#### V11: stale check 效果

**观察项**：
- [ ] stale_candidates 是否合理（时间绑定 > 14d 的被标记）
- [ ] 是否有 false positive（永恒偏好被标为 stale）
- [ ] LLM 调用开销是否值得（vs 产出量）

#### V12: synthesis cosine dedup（> 0.90）

**观察项**：
- [ ] 是否有 `synthesis_quality_reject` + `reason='cosine_dup'` 的 audit
- [ ] 被拒的 synthesis 是否确实与已有 consolidated 重复
- [ ] 0.90 阈值是否太严（有效 synthesis 被误判重复）

---

## 五、已知限制（by design，非 bug）

| # | 限制 | 原因 | 后续 |
|---|---|---|---|
| 1 | `openai` SDK 需用户自行 `npm install openai` | 不在 dependencies 中（动态 import） | 文档化 |
| 2 | Jina 后端纯 `fetch()`，无 SDK | Node 18+ 内置 fetch，零依赖 | 可接受 |
| 3 | model-switch 全量 NULL embedding → re-backfill 慢 | 保证同一 DB 只有一种模型的向量 | 可接受 |
| 4 | `transcript_cleaner.rules` 用户覆盖格式待 v0.9 定义 | DEFAULT_RULES 含 RegExp 无法 JSON 序列化 | v0.9 |
| 5 | 自动 merge 无用户确认 = 永不 | 合并结果可能不准确 | by design |
| 6 | merged_duplicates 保留第一个 source 的 id 而非新建 | 避免 id 膨胀 + 保持 lineage 简洁 | 可接受 |
| 7 | `embedding_api_error` audit 仅在 vec_backfill 路径有，weekly-synthesis cosine dedup 路径静默 catch | L1 review 结论：defer | v0.9 |

---

## 六、backlog 项（m462 + review 遗留）

| # | 项 | 来源 | 优先级 | 状态 |
|---|---|---|---|---|
| 1 | cron list --verbose showing audit details | m462 backlog | P2 | ✅ 已实现（migration 010 + `--verbose` flag） |
| 2 | unify success/completed display | m462 backlog | P2 | ✅ 已实现（SQL CASE 映射 `success`→`completed`） |
| 3 | tasks + task_runs add duration_ms field | m462 backlog | P3 | ✅ 已实现（migration 010 + write on completion） |
| 4 | synthesized=0 连续 skip logic | m462 backlog (deferred pending data) | 观察 | defer v0.9 |
| 5 | `parseLlmStructured` / `parseMergeResult` 统一到 llm-parse.mjs | L2 review | v0.9 | ✅ 已实现（`parseRawLlmOutput` 共用基底） |
| 6 | cosine dedup 路径加 `embedding_api_error` audit | L1 review | v0.9 | ✅ 已实现（catch 内 writeAudit） |
| 7 | `--json-schema` opt-in + raw_sample 诊断 | dogfood 2026-06-08 | P1 | ✅ 已实现（security-audit.mjs） |
| 8 | task_runs lease 完成标记 | dogfood 2026-06-08 | P1 | ✅ 已实现（loop.mjs + task-runs.mjs） |
| 9 | detect-claude binary resolver | dogfood 2026-06-08 | P2 | ✅ 已实现（detect-claude.mjs, 同 detect-node 模式） |
| 10 | openai 后端支持自定义 base URL / model / dim | dogfood 2026-06-08 | P1 | ✅ 已实现（openai.mjs applyConfig + provider.mjs 同步调用 + dim 自动检测） |

---

## 七、commit 历史

```
2a7a6ff fix(v0.8): apply code review findings (S1-S3 + M1/M3-M5 + L3-L5)
bbb658c docs: v0.8 spec + implementation plan (Synthesis Maturity)
86d0cb9 fix(test): lengthen mock transcripts to pass min_transcript_after_clean threshold
585162c chore(config): bump to v0.8 + embedding/summarize/consolidation config
50c4b11 feat(observability): add synthesis metrics rollup + --synthesis diagnose + stats line
4a757b2 feat(resurrect): add m(merge) option to --contradictions
5c7ec08 feat(weekly): rewrite core loop — clusterBatchV2 + promptV2 + quality scoring
21cb78d feat(weekly): add clusterBatchV2 + synthesis-v2 prompts + quality scorer
c111b8a feat(summarize): integrate transcript cleaner + quality gate into pipeline
6cff59d feat(summarize): add transcript cleaner + quality gate
7c915c3 feat(embedding): add provider switch + model-switch NULL logic
b9a4815 feat(embedding): add OpenAI + Jina embedding backends
1c3b51f feat(schema): add 009_v08.sql — contradiction merged + synthesis rollup
```

---

## 八、dogfood 观察记录（待 dogfood 期填）

| 日期 | 类别 | 观察 / 调整 | 跟进 |
|---|---|---|---|
| 2026-06-05 | V1 ✅ | transcript_cleaned: 2 records, avg stripped 2.4% (260/10927 chars), rule `file_tree` 命中。stripped_pct 合理（低但正确——大部分 transcript 是纯对话） | PASS |
| 2026-06-05 | V2 | quality_gate_reject: 0 records（daemon 尚未产出新的 auto_inferred） | 待更多 summarize 数据 |
| 2026-06-05 | V3 ⚠️ | v0.8 格式确认 ✅（synth_proposed 字段存在）。但 synth_proposed=0 / dedup_merged=0 / 12 LLM calls / 1021s。**后经 6/8 排查，根因非"碎片化"而是 parser bug——见 6/8 V3 条目** | 见 6/8 修复 |
| 2026-06-05 | V6 ✅ | `--synthesis` 输出正常（3 段完整），无 crash。正确显示 transcript cleaned 数据 + 0 proposed/accepted synthesis | PASS |
| 2026-06-05 | 基础 ✅ | schema version=9 ✅, daemon alive (heartbeat 4s) ✅, 937/937 tests ✅ | PASS |
| 2026-06-08 | 基础 ⚠️ | security_audit W24 连续 4 次 `security_audit_parse_failed`。当时误诊为"security_audit 特有问题"并将 jsonSchema 改为 opt-in 规避。**实际根因是全局 parser bug（见 6/8 V3 条目）：`parseRawLlmOutput` / `parseMetaSynthesisOutput` 不读 `structured_output`，导致 `--json-schema` 模式所有成功调用结果被静默丢弃**。security_audit 的 opt-in 规避仍保留（作为防御层） | FIXED（根因已在 V3 修复） |
| 2026-06-08 | 基础 ⚠️ | task_runs lease 设计缺陷：`tryClaimLease` 写入 'running' 后，成功/失败均无代码标记 'completed'/'failed'。所有 weekly tasks（W24 的 weekly_synthesis / security_audit / contradiction_audit）全部卡 'running'。修复：`loop.mjs` 的 `runTask` 完成后调 `markRunningLeaseByType`。回溯清理 6 条 stuck leases | FIXED |
| 2026-06-08 | V4 增量 | openai 后端扩展支持自定义 base URL / model / dim：`openai_base_url`、`openai_model` config 字段 + `OPENAI_BASE_URL` env；`openai_dim` 从首次 embed 响应自动检测。修复 model-switch bug：`applyConfig()` 从 `load()` 拆出到 `getProvider()` 同步调用，确保 modelId 在 model-switch 检测前已正确。`unload()` 重置 modelId/dim 到默认值防测试泄漏 | 待 V4 完整验证 |

| 2026-06-08 | V3 🔴→✅ | **synth_proposed=0 根因定位与修复**。`claude -p --output-format json --json-schema` 返回 `{"result":"", "structured_output":{...}}`，但 `parseRawLlmOutput`（llm-parse.mjs）只读 `result`（空字符串），递归解析后返回 null → fallback 到空数组。`parseMetaSynthesisOutput`（monthly-meta-synthesis.mjs）有独立同款 bug。修复：两个解析器均优先检查 `structured_output` 字段。手动测试 `claude -p --json-schema` 32s 完成、输出正确的 `merged_duplicates` + `synthesized`。961/961 pass。次要问题：6/7 凌晨 2/9 次 LLM 调用 exit 143 超时（180s timeout），可能是临时性网络/速率限制，非系统性 bug | FIXED |
| 2026-06-08 | V3 ✅ | **手动触发 weekly_synthesis 验证 parser 修复生效**。结果：synth_proposed=19, synth_accepted=19, synth_rejected=0, dedup_merged=18, stale_flagged=17, llm_calls=16, duration=1574s (~26min)。3 scopes 处理，每 scope ~5 clusters。产出 19 条 cron_consolidated 记忆（8 rule + 11 consolidated）。rule 类型质量高（跨会话行为偏好），consolidated 类型仍偏向实现细节汇总——根因是存量 auto_inferred 记忆中版本快照、test count 等低抽象记录过多（~50 条）。**pipeline 端到端通畅确认** | PASS — 后续：清理存量低质量记忆后重跑观察质量提升 |
| 2026-06-08 | V5 ✅ | contradiction merge 完整验证。手动造测试数据：(1) 不可合并对（semicolons always vs never）→ LLM 正确返回 `merge_possible=false` + 原因；(2) 可合并对（ESLint 两条互补规则）→ LLM 合并质量好，新 mem `type='consolidated'` + `parent_ids=[509,510]`，原记忆 `status='superseded'`，alert `acknowledged_action='merged'`，audit `contradiction_merged` 完整。测试数据已清理 | PASS |
| 2026-06-08 | V6 ✅ | `--synthesis` 诊断重新验证（之前 CLI 入口问题导致无输出，直接调用正常）。三段输出完整：input quality（3 cleaned, 2.2% stripped, 0 rejects）/ weekly synthesis（9 runs, 0 proposed）/ output quality（0 consolidated）。无数据时友好提示，无 crash | PASS |

---

**End of v0.8 dogfood doc.**
