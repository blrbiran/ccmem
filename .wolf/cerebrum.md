# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-05-30

## User Preferences

- **Conversation language**: Chinese (中文)
- **Documentation language** (`docs/**`): Chinese (中文,prose 与注释)
- **Code, comments, and git commit messages**: English
- **User-facing message strings in code output**: English. This includes:
  - stderr output (e.g., `process.stderr.write('ccmem: ...')`)
  - CLI command stdout / prompts / confirmation dialogs
  - Error messages thrown to user
  - Log messages
  - Audit log `reason` / `action` fields
  - Any string literal that may eventually be displayed to the user
  Even when these appear inside Chinese-language spec documents, the string
  literals must be English. Chinese is reserved for prose/descriptions around code.
- **Workflow**: docs-first then PoC. When user says "先 X 再 Y", execute
  sequentially — don't parallelize. The order implies "confirm step1 before step2".

## Key Learnings

- **Project:** ccmem — Claude Code 跨会话语义记忆插件
- **[2026-05-22] Hook 与 Daemon 的执行权分工**:hook 内仅允许 SQLite 同步 I/O +
  JSON 输出。任何 LLM 调用 / spawn / 网络请求必须在 daemon 中完成。
- **[2026-05-27] Claude Code `!bash` 双流均注入 LLM**:slash command 的 stdout 与
  stderr **都**进入 LLM 上下文(PoC 证实)。元数据走 audit_log + 指针,不直接打印。
- **[2026-05-27] Slash command 不继承 `CLAUDE_PLUGIN_ROOT`**:附录 E PoC 证实。
  Slash command 必须走 PATH 上的 `ccmem` CLI,hook 走 `${CLAUDE_PLUGIN_ROOT}`。
- **[2026-05-28] Schema/Code 一致性原则**:任何被代码引用的 column / table 必须
  在 schema 中显式声明。C-1 review 发现 6 处 column 引用但未定义、C-4 发现整张
  memory_feedback 表无 CREATE TABLE、C-3 发现 mode_state vs config_kv 矛盾。规范:
  PR 引入新 SQL 引用必须同步更新 schema 章节,grep checklist 加这一项。
- **[2026-05-30] 本机验证要显式用 `/usr/local/bin/node`**:默认 `node` 是 v20.19.5,
  但当前实现依赖 `node:sqlite`; `/usr/local/bin/node` 是 v24.13.0,可以稳定跑测试。
  在这个仓库里执行 sqlite 相关测试/脚本时,不要假设 PATH 上的 `node` 可用。
- **[2026-05-30] CLI 集成测试必须与测试进程共享 `CCMEM_DATA_ROOT`**:如果测试里先
  用库 API 写 SQLite,再起子进程跑 CLI,必须让当前进程和 CLI 进程指向同一个 data root;
  否则 CLI 会读到另一份 DB,表现为查询结果 `undefined`。
- **[2026-05-28] 冗余字段反 SSOT**:数据已有 single source of truth 时不应在其它
  位置冗余存储(易失同步)。C-2:`parent_ids` 应是纯整数数组而非 `[{id, depth}]`,
  depth 由 `consolidation_depth` 列承担,不再 JSON 内嵌。
- **[2026-05-28] 命令面合并优于并存**:list / search 重叠功能("看记忆")应合一,
  不同心智(浏览/检索)通过"是否带 query"区分。C-6 把 search 合入 list,命令
  面减一,tab 补全更高效。
- **[2026-05-28] 缓存失效要 daemon + Tier 1.5 双兜底**:I-1 injection_cache 不会
  随 trust / consolidation 自动重生 → 长期失真。daily_maintenance + Tier 1.5
  共享 lease 双兜底,任一活的都保证 ≤ 24h 窗口。
- **[2026-05-28] 反馈推断 4 层非全在 daemon**:I-2 澄清 — L1/L2/L2.5 都在 hook
  同步跑(无 LLM),只 L4 在 daemon。daemon 死时实时反馈仍工作,影响远小于直觉。
- **[2026-05-28] floor 0.2 是减轻而非解决死锁**:I-3 — 灰区记忆即便 floor 后仍
  几乎不可能进 top-K。真正的出路是用户主动 resurrect 或 14d 自动 archive(给
  懒用户的 default)。代码里的 floor 不能让读者误以为问题已解决,文档必须明示。
- **[2026-05-28] LIKE fallback 必须覆盖中英文短词**:I-4 — trigram 对 < 3 字符
  query 召回 0,中文 1-2 字 + 英文 2-3 字符缩写(QA/DB/API)都是盲区。dogfood
  期撞到任一即证伪假设,v0.1 必须双语兜底,词边界限制(空格 boundary)防 substring 误命中。
- **[2026-05-29] 经验值阈值必须配 config + metrics**:M-3-A — 凭直觉选的魔数
  (3 token / 30% ratio 等)文档里要明示"first guess",config 暴露调优 hook,
  metrics 追踪 false-positive / false-negative rate 让 dogfood 期能调。
- **[2026-05-29] LLM 无法遵守它拿不到的约束**:M-3-B — prompt 里写 "depth span ≤ 2"
  但 LLM 看不到 source depth → 伪约束。硬边界(容量/深度/batch size)是代码职责,
  prompt 只承担语义工作,把硬约束描述为"已保证的输入条件"而非"你必须遵守"。
- **[2026-05-29] 相似度量必须 mode-aware + 阈值配套**:M-3-C — trigram(lexical)
  与 embedding(semantic)是不同尺度,阈值不能直接复用。trigram 召回更严需降阈值
  (0.5 vs 0.8)。提供 `similarityMode()` 切换,各调用点用 mode-aware 默认值。
- **[2026-05-29] enum 命名按"触发源"语义,不按实现位置**:M-3-D — `RAN_BY` 三档
  应是 DAEMON(定时)/ OPPORTUNISTIC(机会)/ MANUAL(显式)。原 HOOK_LAZY 既不
  hook 也不 lazy,误导新读者。命名是文档化的一部分,错误命名比错误代码更难发现。
- **[2026-05-29] 实施 spec 引用设计 SSOT**:M-4-A — v0.x-spec 不应复制 design.md
  的实现代码,改为 ALGORITHM 引用 + 不做清单。两份独立维护 = 高发漂移源。
- **[2026-05-29] slash command 入口统一 `cmd<Verb>` 前缀**:M-4-E — 与文件结构
  `lib/cmd/<verb>.mjs` 对齐;前缀使 IDE tab 补全聚类。内部 helper 用职责命名
  (`promoteToGlobal` 而非 `promoteGlobalCommand`)。
- **[2026-05-29] design.md 代码片段默认 v0.2+ 完整版,v0.1 实现按白名单跳过**:
  M-4-C — design.md 是"长期能成为什么",其代码示例是 v0.2+ 完整版;v0.1 实现的
  边界由 v0.1-spec §4.6 hook 白名单严格 enforce。关键 v0.2+ 行加 `⚠ v0.2+ ONLY`
  显眼标注。
- **[2026-05-29] 不在版本未到时定型 schema**:M-4-D — v0.5+ 引入的 `vec_*` 表
  schema 应推迟到实施期定型(届时需结合 sqlite-vec / embedding 模型选型一并设计)。
  当前完成判据写"逻辑约束 + SQL 通配"而非具体表名,是有意为之的设计延迟。

## Do-Not-Repeat

- **[2026-05-27]** 不要凭记忆回答 spec 内容。任何关于 spec 的事实陈述必须 grep
  当前文件验证。spec 在迭代,印象停留在旧版本。

## Decision Log

决策完整 rationale 见 [ccmem-design-revisions.md](../docs/ccmem-design-revisions.md)。
以下按主题分组,每条只保留结论与指针。

### 主题 1: 安全与防御

| 决策 ID | 结论 | 详见 |
|---------|------|------|
| L-1 | 用户自定义 pattern 防 ReDoS:v0.1 禁用 extra patterns;v0.2 加载时 fuzz test + 50ms 超时,纯 Node RegExp 零依赖(**否决 re2 npm**) | design.md §10.2.1, revisions §七 U-9 |
| L-2 | scope 是安全边界:security_audit 按 scope 分轮,不跨 scope 自动调 trust;跨 scope 高相似度写只读 `cross_scope_alerts` | design.md §8.2, motivation §核心理念 5 |
| S-3 | 数据安全 > 用户便利:migration 失败 hard exit + backup + bypass env,不开 safe mode | v0.1-spec §7.4.1 |
| S-4 | 防御纵深覆盖反向数据流:transcript-read 路径也 strip critical patterns + 角色固定 + JSON schema 验证 | design.md §10.3 |
| U-9b | 非 git 目录强制 `--scope`(exit 64),防 /tmp 随手 save 污染全局 | v0.1-spec §5.2 |

**泛化**: 写入闸门 ≠ 全部防御 — 任何"读已有数据 → 喂 LLM"的反向路径都是独立攻击面。

### 主题 2: 性能与架构

| 决策 ID | 结论 | 详见 |
|---------|------|------|
| U-PERF | 分层 SLO:ms_business(代码可控)+ ms_total(含 Node 冷启动)独立报警 | v0.1-spec §4.1/§4.2 |
| U-DEPS | Node ≥22.5 + 内置 `node:sqlite`,零运行时依赖。hook 带 `--experimental-sqlite` | v0.1-spec §4.3 |
| T-5+U-1 | daemon-optional 三档:Tier 1(注入/命令)不依赖 daemon;Tier 1.5(lazy SQL maintenance)用户命令 prelude 跑;Tier 2(LLM)daemon 才跑 | motivation §daemon-optional, v0.1-spec §4.1 |
| P-1 | daemon_lock(进程锁)与 task_runs(幂等 lease)职责分离,不互相替代 | design.md §7.8/§O-1 |
| ECC-R2 | UserPromptSubmit 超长 prompt 截断 2000 字符再检索 | v0.1-spec §4.2 |
| ECC-R3 | trash 文件 atomic write(tmp+rename);metrics appendFile POSIX < PIPE_BUF 原子 | v0.1-spec §5.4/§8.2 |

**泛化**: 性能 SLO 拆"我能控制的"与"我控制不了的"两条线。优先用平台内置,零依赖 > 用最好的库。

### 主题 3: 命令与交互设计

| 决策 ID | 结论 | 详见 |
|---------|------|------|
| R-4 | stdout/stderr 都进 LLM → 元数据走 audit_log + stderr ≤ 2 行 LLM-safe 指针 | v0.1-spec §5.0.2, 附录 D |
| ECC-R1 | slash command 用 `command:true` + `disable-model-invocation:true`(直执行,省 LLM round-trip) | v0.1-spec 附录 B |
| P-4 | 版本门控统一:FeatureNotAvailableError + exit 78 + workaround 提示 | v0.1-spec §5.0/§5.0.1 |
| S-5 | 输出格式按内容性质(表格/时间线/bullets)选,不按命令归类;TTY 降级强制 | design.md §12.6 |
| Q-2 | friction 按 authorship:save(用户=作者)无确认;promote(用户=接收者)需 verbatim | design.md §12.3 |
| T-9 | 命令矩阵精简:admin 命令面扩张优先 flag 不开新 verb | revisions §五 T-9 |

**泛化**: LLM 可见输出必须 LLM-safe(不含推断模板/shell 模板/if-then 结构)。friction 看"谁是作者"不看"会发生什么"。

### 主题 4: 记忆生命周期与 Trust

| 决策 ID | 结论 | 详见 |
|---------|------|------|
| I-3→T-4 | trust 死锁防护:floor 0.2 保留;月度强制曝光**删除**,改 opt-in `/ccmem:resurrect` | revisions §五 T-4 |
| T-3 | L2.5 transcript 引用扫描:Stop hook 检测 assistant 引用了 mem → helpful +0.025 trust。补足正反馈源 | revisions §五 T-3 |
| U-5 | trust 上限统一 1.0(所有 source);差异化只在初始值与观察期 | revisions §七 U-5 |
| U-7 | 排序公式 5 项→4 项:删 probation_boost | revisions §七 U-7 |
| 2026-05-22 | 类型 5→4:删 skill,合入 rule+tags | design.md §4.1 |
| W-1 | weekly_synthesis 按语义主题分组 + 与现有 consolidated 做 thematic merge,不只按时间窗口 | revisions §十四 W-1 |
| W-2 | synthesis 双产出:consolidated(摘要)+ rule(泛化原则);rule 是最高行动价值产出 | revisions §十四 W-2 |
| W-3 | consolidated content ≤ 80 字符(索引+结论);详情走 parent_ids 追溯 | revisions §十四 W-3 |
| W-4 | 月度 meta_synthesis 防 consolidated 膨胀:同主题 ≥ 3 条 → merge 为 depth+1 | revisions §十四 W-4 |

**泛化**: 沉默不算 helpful。正反馈源必须显式。trust 复活机制必须 user-in-the-loop。整合最有价值的产出是泛化原则(rule),不是事实归档(consolidated)。

### 主题 5: Schema 与数据模型

| 决策 ID | 结论 | 详见 |
|---------|------|------|
| R-5 | migration 事务化:`runMigration()` helper + schema_migrations 历史表 v0.1 即建 | v0.1-spec §7.4 |
| Q-4 | CHECK enum 扩展走 rename→recreate→copy→drop recipe。枚举稳定(< 6 值)用 CHECK,不稳定才用字典表+FK | v0.1-spec §3.1 |
| N-1+Q-1 | v0.x 边界三重防漏:schema 注释 `reserved` + §4.6 白名单 + grep checklist。白名单是快照,随 spec 显式演进 | v0.1-spec §4.6 |
| P-2 | metrics.jsonl(可观测/可共享/可丢失)与 recent_injections(可查询/含 PII/不可丢)严格分离 | design.md §13.1 |
| 2026-05-22 | project_key: registry 归一(GitHub/GitLab/Gitee/Bitbucket/codeup) + manual alias + SHA256 fallback | design.md §8.1, v0.1-spec §10 |
| S-1 | 经验值参数必须文档化推算来源 + 用户视角命名 | design.md §7.3.1 |

**泛化**: "用于分析"与"用于查询"是两类数据,默认独立存储。schema 演进是一等公民。

### 主题 6: Plugin Packaging

| 决策 ID | 结论 | 详见 |
|---------|------|------|
| V-1 | hook command 用 `${CLAUDE_PLUGIN_ROOT}`;slash command 走 PATH 上的 ccmem CLI | v0.1-spec §4.3, 附录 E |
| V-2 | plugin.json 5 条硬约束:version 必填 / commands 必须 array / 无 agents / 无 hooks / mcpServers:{} | v0.1-spec §11.0 |
| ECC-R1 | command .md 用 `command:true` + `disable-model-invocation:true` 直执行 | v0.1-spec 附录 B |

**泛化**: plugin packaging 约束是隐性的、validator 不友好的。用已验证实现的 NOTES 作输入,不依赖官方文档。ship 前必有 manifest regression test。

### Config 设计(补充)

| 决策 ID | 结论 | 详见 |
|---------|------|------|
| 2026-05-22 | 4 层优先级:defaults < user < project < runtime。null=delete deep merge | design.md §14 |
| B5 | 项目级 config 只认 `project_key` / `project_key_remote_priority` 两个 key | v0.1-spec §7.1 |
| U-6 | shadow 三档清晰边界:active(全功能) / shadow(read-only diagnostic) / off(early-exit) | v0.1-spec §5.6 |

### 主题 7: 实施策略

| 决策 ID | 结论 | 详见 |
|---------|------|------|
| 2026-05-30 | v0.1 + v0.2 作为一个交付实现；实施顺序采用 vertical slicing；运行时通过 capability gate 保留 Tier 退化语义 | docs/superpowers/specs/2026-05-30-ccmem-v01-v02-implementation-design.md |
