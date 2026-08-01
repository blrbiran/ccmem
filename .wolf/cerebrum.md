# Cerebrum

> OpenWolf's long-term learning memory.
> Compacted on 2026-06-19; archive snapshots: `cerebrum.archive.2026-06-04.md`, `cerebrum.archive.2026-06-19.md`
> Last updated: 2026-06-19

## User Preferences

- **Conversation language**: Chinese (中文)
- **Documentation language** (`docs/**`): Chinese (中文, prose 与注释)
- **Code, comments, git commit messages, and user-facing runtime strings**: English
- **Workflow**: docs-first then PoC. When the user says “先 X 再 Y”, execute sequentially rather than parallelizing.
- **Implementation workflow**: default to TDD. Write or adjust a failing test first, then implement the minimal code to make it pass.
- **Housekeeping**: when slimming `.wolf` operational files, prefer archival compaction over deletion and keep only a short recent raw tail in `memory.md`.

## Durable Constraints

- **Hook / daemon boundary**: hooks stay synchronous and lightweight; daemon owns async, LLM, spawn, and network work.
- **LLM-visible terminal output**: Claude Code slash-command stdout and stderr both enter model context; metadata belongs in audit/state, not raw terminal output.
- **Plugin runtime split**: slash commands should invoke PATH `ccmem`; hooks should use `${CLAUDE_PLUGIN_ROOT}`.
- **Runtime capability over path heuristics**: FTS5 availability is a runtime capability, not a binary-path heuristic.
- **Entrypoint invariants**: launcher, hook, and daemon paths must stay aligned on real-path resolution, sqlite/runtime flags, warning behavior, and bridge command wiring.
- **Lease semantics**: daily and weekly leases are local-calendar concepts; use shared helpers and carry `lease_key` through task payloads.
- **Bridge selection**: task-layer real-bridge execution should depend on configured command/args, not on a release-only env gate.
- **Runtime config precedence**: `config_kv` toggles must take precedence over static config defaults when both exist.
- **External comparisons**: trust checked source code over README or marketplace copy when comparing reference projects.

## Durable Lessons

- **Retry coverage means closure**: prove queueing, rerun-to-success, user-visible side effects, and lease completion instead of stopping at “retry was scheduled”.
- **`summarize_pending` supersede rule**: delayed retries must still yield to newer `last_message_seq` state before rerun.
- **Structured bridge contract**: tasks that parse Claude output as JSON must enforce `--output-format json --json-schema` and tolerate Claude's `{ type: 'result', result: '...' }` envelope.
- **Transcript parsing**: shared helpers must tolerate both array and string `message.content` shapes; Stop hooks should return `{}` rather than `hookSpecificOutput` payloads.
- **Long-session summarization**: summarize from the transcript tail, then refine or truncate after parsing rather than during parse.
- **Full-suite closure discipline**: schema advances, config-gate changes, and large same-file refactors require broad suite reruns because stale fixtures and version assertions hide outside targeted slices.
- **Test/runtime alignment**: this repo's sqlite-dependent verification should use `/usr/local/bin/node`; broad `npm test` coverage must match that runtime.
- **Context-history surface**: file-based injection reviewability depends on both `context_snapshots` and `context_write_log`, and cleanup must avoid clobbering active parallel sessions.

## Do-Not-Repeat

- Do not answer spec, packaging, or marketplace details from memory alone; verify against current files or current UI behavior.
- Do not treat `/usr/local/bin/node` path alignment as the fix for sqlite capability gaps; capability-probe the active runtime.
- Do not derive lease keys from UTC date slices or recompute them from completion-time `new Date()`.
- Do not rely on empty-stderr assertions in hook or daemon suites.
- Do not hard-code inserted memory ids or project keys in integration fixtures.
- After large same-file helper extraction or replacement, grep for duplicate declarations before broad test runs.
- 2026-07-31: When a cache/lookup key format changes (e.g. `query_embedding_cache.prompt_hash` moving from bare `modelId` to a `provider:model:dim` signature in v0.13 B1), any test fixture that hand-computes that key with the old inputs silently misses — it doesn't error, the code just falls through to the next retrieval path. Grep test fixtures for the old key-input variable name whenever a hash/key derivation changes, not just for direct assertions on the changed field.

## Long-Lived Decisions

- **Runtime architecture**: the daemon-optional model remains — Tier 1 works without daemon, Tier 1.5 runs opportunistically, Tier 2 needs daemon.
- **Retrieval architecture**: FTS-backed retrieval is an optimization, not a schema requirement.
- **Operational file policy**: `.wolf` files may be compacted periodically, but only after creating dated archive snapshots.

### 2026-08-01 · V4 验证过程中的接口事实（省下一次重复发现）
- `retrieveMemories()` 每行的分数在 `row.score.{fused,fts,jaccard,semantic}`，**不是** `row.meta`（`renderRow` 只在 score 非空时挂 `score` 键）。
- `dedup.mjs` 的候选池**不是 FTS 捞的**：`candidateRows()` 取「最近 touch 的 20 条」（`ORDER BY last_touched_at DESC, id DESC LIMIT 20`）。`ftsQuery` 只作内容合法性闸门。用不在这 20 条里的记忆做查重探针，会得到 `duplicate=false` —— 红得毫无意义。
- `audit_log` 的列是 `details`（不是 `detail`）；`memory_feedback` 的列是 `evidence`（不是 `reason`）。
- 验证签名过滤时，异签名要用**同维不同模型**（如 `openai:text-embedding-3-large:1536`），这才是注释里说的 plausible-but-wrong 危险情形；维度不同会被长度检查安全地挡掉，验不出东西。
- `retrieveMemories` 的 `timing.candidatePool` / `retrieval_stale_vecs` 是只属于 cosine 通道的量化观测量，能绕开词法回退造成的假绿。

### 2026-08-02 · 环境变量取证的可靠手段（`ps eww` 在这台机器上是坏的）
- **`ps eww -p <pid>` 读不到进程环境** —— 对自己的 shell 执行都查不到 `env` 里明明存在的变量（macOS 限制）。任何基于它的"该进程没有 X"都是测量失效。**用它之前先对自己的 shell 自测一次。**
- 可靠替身：`zsh -f -c 'echo $VAR'`（`-f` 不读任何 rc，仍有值 ⇒ 来自父进程继承）；进程自身写出的产物（daemon 写的签名）；`memory_feedback.session_id` + 时间戳（判定某次 hook 属于哪个会话）。
- `~/.claude/plugins/ccmem` 是指向 `~/code/skills/ccmem` 的**符号链接** ⇒ hook 侧代码改动下次调用即生效；只有 daemon 需要 uninstall/install（plist 冻结安装时环境快照）。
- 加了配置回落之后，`env -u CCMEM_CONFIG_PATH` **不再构成测试隔离** —— 必须同时钉 `CCMEM_DATA_ROOT`，否则测试读到真实用户配置（含 API key）。

### 2026-08-02 · hook 超时的两个坑
- `hooks/hooks.json` 的 `timeout` 单位是**秒**，且必须**严格大于** `withHookSafety` 的内部预算（`PROMPT_SUBMIT_BUDGET_MS`），否则 harness 会在内部降级路径跑完之前杀掉进程，stdout 与 metrics 都写不出来。余量还要覆盖 node 启动与模块加载（`ms_total` 不含这两段）。
- **metrics.jsonl 的延迟统计有幸存者偏差** —— 行是 hook 自己写的，被杀的那次不会留下行。所以"超预算样本 = 0"绝不能当作"没有超时"。
- OpenAI SDK 默认 `maxRetries: 2`，会把 `timeout` 变成它自己的倍数（800ms 配置实测 1683ms）。**设了超时就要同时设 maxRetries**，否则超时不是预算。
