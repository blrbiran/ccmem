# 8 个死键的处置提案（给人类裁决用，**本文件不执行任何处置**）

> 输入是 `specs/2026-08-14-default-config-dead-keys.md`（那份只回答"有没有消费者"）。
> **本文件回答的是它明确不回答的那个问题："这个键该不该存在"** —— 但**只给依据和风险，不做决定**。
> **只读调查，未删任何键、未改任何代码、未跑全量套件。** 写作时点 2026-08-19，**测量窗口仍开着**。
>
> 🔴 **前置纪律（ⅩⅢ.6 ②，不要绕过）**：**删键与接线是两个相反的处置**，
> 且**接线一个躺了很久的键 = 静默行为变更**（Ⅲ.6 那个坑的镜像）。
> ⇒ 下面每个键都**同时给出两个方向的代价**，不要只看推荐。

## 调查把 8 个键分成了三类（这才是要点，不是一张删/留清单）

原清单是平的。逐个查完调用点之后，**它们的性质差别很大**，处置也应该不同：

| 类 | 含义 | 键 |
|---|---|---|
| **Ⅰ. 配置与实际行为直接矛盾** | 键有值，代码里有对应行为，但**行为写死成了另一个数** ⇒ **读配置的人被误导** | `retrieval.like_fallback.max_terms` |
| **Ⅱ. 承诺了一个从未发生的行为** | 键描述了一种处理，**代码里根本没有那条路径** | `security.quarantine.hard_delete_days`、`security.cross_scope.similarity_min`、`consolidation.minBatchSize`、`inject.max_chars`、`cron.dead_letter_alert` |
| **Ⅲ. 纯孤儿** | 既无行为也无矛盾，纯粹多出来的一行 | `llm.claude_p_timeout_per_task.l4_review`、`security.tier3.block_user_explicit` |

**Ⅰ 类最急、Ⅲ 类最不急** —— 而原清单把它们摆得一样重。

---

## Ⅰ 类（1 个）：配置在撒谎

### 1. `retrieval.like_fallback.max_terms = 5` 🔴 **本轮最该先处理的一个**

**实测**：
- `extractShortTokens(text, maxTerms = 5)`（`retrieval.mjs:70`）—— **默认值 5，与配置一致**。
- 但**全仓库唯一的调用点**把它写死成 10：`likeSearch` 里 `extractShortTokens(prompt, 10)`（`retrieval.mjs:140`）。
- 同级 `enabled` / `trigger_when_fts_below` **都是活的**（`retrieval.mjs:275-276, 411-412`）。

⇒ **配置文件说 LIKE 回退取 5 个词，实际取 10 个。** 一个读 `config.default.json` 的人会得到**错的行为模型**，
而且同一小节里另外两个键**确实生效**，这让它更像"生效的"。

**两个方向的代价**：
- **接线**（把 `10` 改成 `cfg…max_terms ?? 5`）：**这是行为变更** —— LIKE 回退的召回面从 10 词收窄到 5 词。
  ⚠️ 而 LIKE 回退正是 FTS 命中不足时的兜底，**收窄它会直接影响召回**。**不要顺手做。**
- **改默认值**（把配置里的 `5` 改成 `10`，文档跟随现实）：零行为变更，但**等于承认这个键仍然是死的**。
- **删键**：零行为变更，且消除误导；代价是失去一个本来合理的可调项。

📌 **注意它与测量窗口的关系**：接线会改变检索行为 ⇒ **窗口期内绝对不能做**。改默认值/删键不影响延迟分布。

---

## Ⅱ 类（5 个）：承诺了从未发生的行为

### 2. `security.quarantine.hard_delete_days = 14` 🔴 **后果最重的一个**

**实测**：全仓库**没有任何自动硬删路径**。`DELETE FROM memories` 只出现在
`lib/cmd/forget.mjs:17`（**用户主动 forget**）与 `db.mjs` 的 FTS 触发器里。
同级 `sunset_days = 30` **是活的**（`daily-maintenance.mjs:78`、`stats.mjs:171`、`diagnose.mjs:521,541`）——
但 sunset 做的是**改状态**，不是删数据。

⇒ **配置声称"隔离区的记忆 14 天后硬删除"，而这件事从未发生过。**
🔴 **这不是普通死键，是一条没兑现的数据留存承诺。** 它的读者可能据此以为敏感内容会被清掉。
**处置建议要人类特别对待这一条**（删键 = 承认不删；接线 = 真的开始删数据，**不可逆，且会删掉既有数据**）。
⚠️ **接线这条的风险等级远高于其余 7 个** —— 它一旦接上就是**批量不可逆删除**。

### 3. `security.cross_scope.similarity_min = 0.6`
**实测**：`cross_scope_alerts` 的写入在 `security-audit.mjs:184`，
而 `alert.similarity` 来自 **LLM 返回的 verdict**（`parseSecurityAuditJson(raw)`，:262）。
**没有任何地方拿 `similarity_min` 去过滤** ⇒ **LLM 报多少条就记多少条，不筛。**
同级 `dedup_window_days` / `alert_retention_days` 是活的。
📌 顺带一提（**超出本文件范围，只作记录**）：这个 `similarity` 是**模型给的数**，
与 CLAUDE.md Rule 5「能用代码算的就别用模型」方向相反 —— **不在本轮处置内，但值得单独看一眼。**

### 4. `consolidation.minBatchSize = 5`
**实测**：`selectBatch`（`weekly-synthesis.mjs:42`）**只有 `LIMIT`（上界），没有任何下界判断**；
调用处只传 `weeklyMaxBatch`（:368）。⇒ **批次再小也照跑合并**，`minBatchSize` 从未拦过任何一次。

### 5. `inject.max_chars = 4000`
**实测**：注入**只按条数封顶**（`inject.max_per_prompt` 活，`retrieval.mjs:334`），**没有任何字符数封顶**。
⚠️ 这个键正是清单里"差点漏掉"的那个（子串匹配误命中了 `save.max_chars_per_memory`）——
**注意 `save.max_chars_per_memory = 500` 是活的，但那是"每条记忆的长度上限"，与"每次注入的总字符上限"不是一回事。**
两者名字像、语义不同，**处置时别混。**

### 6. `cron.dead_letter_alert = 5`
**实测**：**cron 侧没有任何 dead-letter 告警任务。** 唯一与 dead letter 相关的展示是
`cli.mjs:449`：`dead_letters > 0 ? 'WARN' : 'OK'` —— **阈值写死为 0，且那是 CLI 展示、不是 cron 告警**。
⇒ 配置声明的"5 次才告警"**既没生效，也和现存的 >0 展示口径不一致**。
📌 这正是原清单标注的那个陷阱：`dead_letters` 在四处出现，但那是 `llm_dead_letters` **指标列**，与本键无关 —— **复核确认该判断成立。**

---

## Ⅲ 类（2 个）：纯孤儿

### 7. `llm.claude_p_timeout_per_task.l4_review = 90000`
同表其余 6 个键全部活着（`claude-p.mjs:58` 动态取键）。**只有这一个没有对应的 `taskType`**，
论证是自封闭的（`l4_review` 这个词在 `scripts/` 下一次都没出现；用户输入那条路被 `TRACKED_TYPES` 白名单挡着）。
⇒ **删它零风险、零行为变更**，是 8 个里最干净的一个。

### 8. `security.tier3.block_user_explicit = false`
已知，见 ⅩⅢ.3（声明了十一个版本、零消费者、零测试）。
🔴 **人类已批准的方向（ⅩⅢ.6 ②）：W1 不接线它，改为新增新键并把这个死键删掉。**
⇒ **本键的处置已有裁决，不在本文件重开** —— 但**删除动作本身仍是独立动作，且要等窗口关闭**。

---

## 建议的处置顺序（**仅建议，等人类点头**）

| 优先 | 键 | 建议 | 为什么 |
|---|---|---|---|
| 1 | `quarantine.hard_delete_days` | **单独裁决**，不要打包 | 是留存承诺，两个方向都重（接线 = 不可逆批量删除） |
| 2 | `like_fallback.max_terms` | **先决定"5 还是 10"**，再决定删/接 | 配置与行为矛盾，读者被误导中 |
| 3 | `l4_review` | 删 | 零风险零行为变更 |
| 4 | `block_user_explicit` | 按 ⅩⅢ.6 ② 随 W1 删 | 已有裁决 |
| 5 | 其余 4 个（`similarity_min` / `minBatchSize` / `inject.max_chars` / `dead_letter_alert`） | 打包裁决 | 同为"承诺未实现"，代价结构相同 |

🔴 **全部处置都要等测量窗口关闭**（第 2 条若选"接线"更是直接改检索行为）。
**本轮不动任何一个键。**

## 效力边界（照 Ⅺ.14 的写法明说）

- 本文件的"没有消费者"**直接沿用** `specs/2026-08-14-default-config-dead-keys.md` 的判据与结论，**未重做全量扫描**；
  本轮新增的是**每个键各自的调用点上下文**（谁是活的邻居、行为写死在哪一行）。
- **逐条复核过的是这 8 个键**，**没有复核"其余 143 个都真的活"** —— 那个方向原清单就说了没做，**本文件同样没做。**
- Ⅰ/Ⅱ 类的判定依赖"我读到的调用点就是全部" —— 用的是全词 grep + 逐个读调用点，
  **对动态取键仍可能假阴**；已知的唯一动态取键处（`claude-p.mjs:58`）已单独论证。
