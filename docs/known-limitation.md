# Known Limitations(已知限制)

> **本文档定位**:汇总 Claude Code / SQLite / launchd / systemd-user 等**ccmem 无法绕过**的外部限制,以及 ccmem 因此采取的工程应对策略。每发现一条新限制就追加一行,**不修改既有条目**(除非完全失效)。
>
> **不在本文档范围**:
> - ccmem 自己的**设计选择**(那是 [ccmem-design.md](./ccmem-design.md) 的范围)
> - ccmem 自己的**功能未实现/降级状态**(那是 [ccmem-v0.1-spec.md](./ccmem-v0.1-spec.md) phase 表的范围)
>
> 本文档只记录**外部强加**的边界。

---

## 一、Claude Code(宿主)

| ID | 限制 | 来源 | ccmem 应对 |
|---|------|------|----------|
| CC-01 | `AskUserQuestion` 最多 4 选项 | Claude Code 工具 schema(JSON Schema `maxItems: 4`) | **不在 hook / slash command 内使用**;`/ccmem:confirm` 走 stdin 自然语言 + 4-tier confirm |
| CC-02 | Hook `stdout` JSON `additionalContext` 无文档化硬上限,但**进入 LLM context window** | Claude Code hook 协议 | 自约束:SessionStart ≤ 1500 字符/scope,UserPromptSubmit ≤ 6 条 × 单条 ≤ 200 字符 |
| CC-03 | Hook 默认 timeout 60s,但 hook 内任何阻塞都直接被用户感知为卡顿 | Claude Code 实现 | 自约束:p95 < 200ms(SessionStart < 500ms);超 1s 主动降级,见 [design.md §6.7](./ccmem-design.md#67-性能预算h5) |
| CC-04 | Slash command 参数不支持复杂 quoted/escaped string,空格 / 换行 / 引号会被 shell 截断 | Claude Code slash command 协议 | `/ccmem:save` 等含 user-supplied content 的命令必须接 stdin 或文件路径,不接位置参数 |
| CC-05 | Hook 输出到 `stderr` 进入**用户终端**,不进入 LLM context | Claude Code hook 协议 | shadow 模式提示走 stderr;audit warning / 降级提醒走 stderr |
| CC-06 | `PreCompact` hook 在 token 即将耗尽时触发,此时任何阻塞 I/O 都放大用户感知卡顿 | Claude Code 行为 | **明确不使用** PreCompact;关键事实在 Stop / SessionEnd 提前入队,见 [design.md §6](./ccmem-design.md#六hook-设计四阶段) |
| CC-07 | Claude Code 不会重试失败的 hook(fire-once 语义) | Claude Code 行为 | 所有 hook 内 DB 操作必须在事务内,失败回滚;不依赖重试恢复 |
| CC-08 | `claude -p` 子进程会再次触发宿主的 hook 链路 | Claude Code 行为 | daemon spawn 时注入 `CCMEM_INTERNAL=1` + session_id 黑名单兜底,见 [design.md §6.0](./ccmem-design.md#60-防递归全-hook-共享前置) |

---

## 二、Cron 调度(launchd / systemd-user)

| ID | 限制 | 来源 | ccmem 应对 |
|---|------|------|----------|
| CR-01 | macOS launchd / Linux systemd-user 启动有秒级延迟,不能保证精确触发 | OS 调度器 | 所有 cron 任务时间用 `:17` 等非整点,且 catch-up 窗口 ≥ 1h |
| CR-02 | 系统休眠 / 关机期间错过的触发**不会**自动追溯执行 | OS 调度器 | `lazy_catch_up` 在 SessionStart 触发,补跑过期 < catch_up 窗口的任务 |
| CR-03 | launchd `StartCalendarInterval` 不支持秒级精度,systemd-user `OnCalendar` 同理 | OS 调度器 | 不依赖秒级精度;所有任务幂等可重跑 |
| CR-04 | 用户未授予 launchd / systemd-user 权限时 daemon 无法常驻 | OS 权限模型 | T-5 daemon-optional:Tier 1(注入/检索/命令)100% 工作;Tier 2(summarize/synthesis/L4/14d archive)**直接缺席**,不再 lazy 降级。`/ccmem:stats` 顶部红条告知用户(motivation §1.3 daemon-optional 段) |

---

## 三、SQLite

| ID | 限制 | 来源 | ccmem 应对 |
|---|------|------|----------|
| SQ-01 | WAL 模式在 NFS / sshfs / SMB 等不支持 `fcntl()` 的文件系统上**不可用** | SQLite 实现 | 启动时 `journal_mode=WAL` 失败 → fail-fast 报错,提示 DB 必须在本地 FS;`~/.claude/` 默认本地 |
| SQ-02 | `WHERE LIKE '%foo%'` 不走索引,大表全扫 | SQLite 引擎 | 内容搜索一律走 FTS5;tags 走标准化的 `memory_tags` 表 + 索引 |
| SQ-03 | 单连接默认串行写,多进程并发写会触发 `SQLITE_BUSY` | SQLite 实现 | hook 与 daemon 不共享连接;hook 用短事务 + `busy_timeout=5000`;daemon 是唯一长连接 |
| SQ-04 | `sqlite-vec` 是 opt-in extension,默认不可用 | SQLite 扩展机制 | Phase 1 默认 FTS5 + Jaccard 两路;Phase 5+ 用户显式开启 vec 才加载;加载失败自动降级 |
| SQ-05 | FTS5 默认 tokenizer 对中文/CJK 效果差(按整行 token);trigram tokenizer 对 1-2 字 query(如"路由")召回 0 | FTS5 实现 | (1) 使用 `trigram` tokenizer 适配中文 ≥3 字 query;(2) **U-4 LIKE fallback**:FTS5 返回 < 3 条时自动用 `LIKE '%<cjk2字>%'` 兜底,详见 [v0.1-spec §4.2](./ccmem-v0.1-spec.md) |

---

## 四、Node.js 运行时

| ID | 限制 | 来源 | ccmem 应对 |
|---|------|------|----------|
| NJ-01 | `better-sqlite3` 是同步 API,在 async hook 中调用会阻塞 event loop | better-sqlite3 设计 | hook 内的同步 I/O 是**预算内的**;daemon 内的长任务用 `node:worker_threads` 隔离 |
| NJ-02 | Node 子进程 spawn 启动延迟约 30-80ms | Node.js 实现 | hook **禁止** spawn;只有 daemon 才 spawn `claude -p` 等子进程 |
| NJ-03 | `process.env` 在 spawn 时不会自动透传非白名单变量(部分代理/wrapper 会过滤) | OS + 透明代理 | `CCMEM_INTERNAL` 同时配合 session_id 黑名单兜底;`CCMEM_TEST_MODE` 显式透传 |

---

## 五、文件系统 / 跨进程

| ID | 限制 | 来源 | ccmem 应对 |
|---|------|------|----------|
| FS-01 | `~/.claude/` 在多用户 / 多 Claude Code 实例下被共享,无内置锁机制 | Claude Code 约定 | daemon 单实例锁(同主机 PID 探测 + 跨主机 hard timeout),见 [design.md §11](./ccmem-design.md) 并发段 |
| FS-02 | 跨 worktree 时 `cwd` 不同但 `git remote origin` 相同 | git 工作机制 | `resolveProjectKey()` 优先用 `git remote origin` URL,fallback 到 `realpath(cwd)`,见 design.md project_key 规则 |
| FS-03 | macOS Spotlight 会扫描 `~/Library/Application Support/` 但**不扫**`~/.claude/`(隐藏目录) | macOS 默认 | DB 放 `~/.claude/ccmem.db`,避免被索引占 CPU |
| FS-04 | ccmem 数据库与 session 状态**仅本机**(`~/.claude/ccmem/` 是单机文件) | 设计选择 | v0.2-0.4 假设单机,跨机器场景请在对端机器独立部署 ccmem。SSH 远程开发(本地 Claude Code 通过 SSH 访问远程)按本地 cwd / project 解析,远程文件视为本地项目的一部分。多机器 sync 设计推迟到 v0.5+,届时根据真实需求决定 schema 字段(可能 `machine_id` / `device_id` / `org_id` 不只一种)。`/ccmem:admin diagnose --sessions` 仅显示本 ccmem 实例的 sessions。 |

---

## 六、其它(待补充)

> 此处用于"发现了但还没想清楚归类"的限制条目。一旦想清楚就移到上面的对应章节。

| ID | 限制 | 来源 | ccmem 应对 |
|---|------|------|----------|
| _ | _ | _ | _ |

---

## 维护规则

1. **新条目只追加,不重排 ID**:`CC-09`、`CR-05` 等顺延。
2. **失效条目标 `[DEPRECATED]`**,不删除,附说明:"Claude Code v1.2.3 起 hook 协议变更,此限制不再适用。"
3. **应对策略链接到 spec 段落**,不要在本文档复述实现细节(否则会双源漂移)。
4. 发现"限制"其实是 ccmem 自己的设计选择 → 应该挪到 design.md,不留在这里。
5. 每次发布前 grep 本文档,确保所有 `ccmem-design.md` 锚点仍有效。
