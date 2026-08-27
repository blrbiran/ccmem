# `DEFAULT_CONFIG` 死键清单（C 的测试 B，第一阶段：只出清单）

> **这是 ⅩⅢ.5 / ⅩⅢ.6 要求的"先出清单给人类，确认死键名单后再定要不要进 CI"那一步。**
> **只读调查，不改任何代码，不新增任何测试，对测量窗口零时序影响。**
> 写作时点 2026-08-14，测量窗口仍开着。**清单是输入，不是行动项** ——
> 删键是独立动作（ⅩⅢ.6 ②已明确：`block_user_explicit` 不要顺手删）。
> 🆕 **处置提案已于 2026-08-19 出** → `2026-08-19-dead-key-disposition.md`。
> 那份文件回答的是**本文件明确不回答的那个问题**（"这个键该不该存在"），
> 并把这 8 个键**分成了三类** —— 本文件把它们摆得一样重，**那个平铺的读法应以那份为准**。

## 结论：151 个叶子键里有 **8 个没有任何消费者**

> 🆕 **2026-08-27 更新**：第 5 项 `security.tier3.block_user_explicit` 已随 W1 删除
> （提交 `chore(config): delete the dead block_user_explicit switch, superseded by
> quarantine_all_sources_at_write`，出处 `docs/superpowers/specs/2026-08-19-dead-key-disposition.md` §8）。
> 本文件下方表格是 2026-08-14 的历史快照，**保留不改**；当前未处置的死键计数为 **7 个**。

| # | 键 | 备注 |
|---|---|---|
| 1 | `inject.max_chars` | 🆕 **差点漏掉，见下方"两次失败的做法"** |
| 2 | `retrieval.like_fallback.max_terms` | 同级的 `enabled` / `trigger_when_fts_below` 都是活的（`retrieval.mjs:275-276, 411-412`），**只有它没接线** |
| 3 | `llm.claude_p_timeout_per_task.l4_review` | 同表其余 6 个键全部活着（动态取键），**只有这一个没有对应的 `taskType`** |
| 4 | `cron.dead_letter_alert` | ⚠️ **陷阱**：`dead_letters` 在四处出现，但那是 `llm_dead_letters` 这个**指标列**，与本配置键无关 |
| 5 | `security.tier3.block_user_explicit` | **已知**，见 ⅩⅢ.3（声明了十一个版本、零消费者、零测试）。🆕 **已处置（删除），2026-08-27，随 W1，见 `2026-08-19-dead-key-disposition.md` §8** |
| 6 | `security.cross_scope.similarity_min` | 同级 `alert_retention_days` / `dedup_window_days` 都活着 |
| 7 | `security.quarantine.hard_delete_days` | |
| 8 | `consolidation.minBatchSize` | 邻居 `weeklyMaxBatch` 活着（`weekly-synthesis.mjs:368`） |

**八个键在 `tests/` 里同样零引用**（键名一次都没出现），也**不出现在 `scripts/` 下任何非 `.mjs` 文件**中
（迁移脚本 `.cjs` / `.sql` 都查过）。

## 判据为什么站得住（不是"grep 了一下没找到"）

用的是一个**必要条件**，不是相似度匹配：

> 一个叶子键只可能通过两条路被消费 —— **① 键名在代码里字面出现**；**② 计算属性动态取键**。
> 两条都不成立 ⇒ 该键不可能被读到。

- **①** 对 151 个键逐个做全词匹配（`\b<leaf>\b`，避开子串），命中范围 `scripts/**/*.mjs`（排除声明处 `config.mjs`）。
- **②** 全仓库枚举 config 对象上的计算属性访问，**结果只有一处**：
  `scripts/daemon/claude-p.mjs:58` 的 `cfg.llm?.claude_p_timeout_per_task?.[opts.taskType]`。
- ⇒ 只有 `claude_p_timeout_per_task.*` 需要额外论证。`l4_review` 的论证是自封闭的：
  `taskType` 的取值要么是代码里的字面串（**而 `l4_review` 这个词在 `scripts/` 下一次都没出现**），
  要么来自 `admin cron run <taskType>` 的用户输入 —— 而那条路被 `TRACKED_TYPES` 白名单挡着
  （`cron.mjs:186, 246`，不在表里直接 `throw unsupported cron task`），**白名单本身也是字面串**。

## 🔴 两次失败的做法（这才是测试 B 该怎么写的依据）

**做法一：路径后缀 grep（`.tier3.enabled`，退化到 `.enabled`）。**
它把候选从 151 缩到 10 个，7 个真死键都在里面 —— 但 **`inject.max_chars` 被判成 LIVE，是假阳性**：
`grep -F .max_chars` 匹配上了**别的键** `max_chars_per_memory` 的子串。
⇒ **子串匹配会漏掉真死键**。改全词匹配才抓到它。

**做法二：全路径匹配（`cfg.a?.b?.c`）。** 151 个键里 **87 个匹配不上（58%）** ——
因为子树被解构或整块传参之后，`embedding.` 这一段就再也不出现了
（`openai.mjs` 拿到的是 `cfg.embedding` 本身，之后只写 `.openai_model`）。
⇒ **在本仓库，路径式检测的假阴性率高到不可用。**

📌 **给测试 B 的直接结论**：
**判据必须是"叶子键名以全词形式出现在 `scripts/` 下"，外加对那唯一一处动态取键的显式豁免**，
**不要写成路径匹配，也不要用子串匹配**。ⅩⅢ.5 担心的假阴/假阳两类**都实际发生了**，各栽一次。

## 效力边界（照 Ⅺ.14 的写法明说）

- 扫描范围是 **git 跟踪的 `scripts/**` 与 `tests/**`**。`docs/` 刻意排除（文档提到键名不算消费者）。
- **本清单只回答"有没有消费者"，不回答"这个键该不该存在"。** 有的键可能是**该接线而没接**
  （`block_user_explicit` 就是这一类：spec 写了语义，代码没接），删掉它和补上它是两个相反的处置。
- **`enabled` 这类通用名的活性未被本方法逐一证实** —— 它们被判 LIVE 只是因为名字出现过。
  本清单保证的是**"判死的这 8 个确实死"**（必要条件不成立），**不保证"其余 143 个都真的活"**。
  要那个方向的保证，得逐个读调用点，**本轮没做，不要假装做了。**
