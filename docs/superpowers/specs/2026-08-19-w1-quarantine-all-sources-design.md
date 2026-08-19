# W1 设计：写入时 quarantine 覆盖面开关

> 产出物是**设计**，不是实现。**本轮不写一行产品代码**（人类指令）。
> 下一步是 `superpowers:writing-plans` 出实现计划。**实现本身等测量窗口关闭。**
>
> 🔴 **本文件取代 `docs/ccmem-v0.14-spec.md` §二 W1 那一节的若干条** —— 那一节的前提已被 ⅩⅢ.3 推翻。
> 冲突时**以本文件为准**（CLAUDE.md Rule 7：冲突要挑一个、说明理由，不要和稀泥）。

## 一、要解决的问题

`evaluateTier3`（`scripts/lib/threat-scan.mjs:87-101`）在写入时对两个 source 做豁免：

```js
if (source === 'user_explicit' || source === 'cron_consolidated') {
  return { action: 'force_demote' };
}
```

⇒ 这两个 source 的记忆**即使命中 Tier-2 威胁模式，也永远不会被 quarantine**，只会被降级。
W1 提供一个开关，让部署方可以取消这个豁免。

📌 **准确说法**：豁免不是"放行"，是**降级成 `force_demote`**。
spec 里"`user_explicit` 永不 quarantine"这句是对的，但**容易被读成"完全不管"**，实现时别按后者理解。

## 二、被 ⅩⅢ.3 推翻、本设计据此调整的三条

| spec 原稿 | 实测 | 本设计的处置 |
|---|---|---|
| 开关是新东西 | `security.tier3.block_user_explicit` **已存在，声明了十一个版本、零消费者、零测试** | **不接线它**，新增新键并**删掉**它（ⅩⅢ.6 ②） |
| `user_explicit` 记忆**永不进** LLM 安全审计 | **错**。三个 pool 里只有 pool B(`security-audit.mjs:78`) 有 source 白名单；pool A(`:60-70`) 与 C(`:97-107`) **没有** | spec 就地更正；**审计面不在 W1 范围内** |
| 应考虑把两处 SQL 白名单一并纳入开关 | **收益近乎零**：两处都是突发探测器，要 `trust < 0.2`，而 `user_explicit` 初始 trust 是 **0.9**（`trust.mjs:4`） | **明确不纳入**，语义收窄为**写入时** |

## 三、设计

### 3.1 配置键

```
security.quarantine_all_sources_at_write   默认 false
```

- **平铺在 `security` 下**，不放 `security.tier3.*` —— ⅩⅢ.6 ② 判定死键的罪状之一就是归属错。
- ⚠️ **但要写明一个反直觉的事实**：`save.mjs:72` 只在 `cfg.security.tier3.enabled` 为真时才调 `evaluateTier3`
  ⇒ **本开关实际被 `tier3.enabled` 门控**。键位平铺看不出这层依赖，**必须在键注释与 spec 里写出来**。
- 两份配置（`scripts/lib/config.mjs` 的 `DEFAULT_CONFIG` 与 `config.default.json`）同步新增。
  🆕 **值级一致现在有测试守着**（`tests/unit/v014-config-value-parity.test.mjs`，2026-08-19）。

### 3.2 函数签名

```js
export function evaluateTier3(t2Result, source, options = {})
```

读 `options.quarantineAllSourcesAtWrite`。

- **函数内不 `loadConfig()`** —— 保持纯函数（spec 原稿这条正确，保留）。
- 用 `options = {}` 而非第三个裸布尔：调用点写 `evaluateTier3(t2, source, true)` 读不出 `true` 是什么。
  `options = {}` 也是本仓库既有写法（`llm-parse.mjs:76`、`claude-p.mjs:199`），符合 Rule 11。
- 调用点 `scripts/lib/cmd/save.mjs:72` 从 `cfg.security` 取值传入。

### 3.3 行为

| `t2.action` | source | 开关 | 结果 |
|---|---|---|---|
| ≠ `force_demote` | 任意 | 任意 | `allow`（**开关不得扩大入口条件**） |
| `force_demote` | `user_explicit` / `cron_consolidated` | `false`（默认） | `force_demote`（**与今天逐字节相同**） |
| `force_demote` | `user_explicit` / `cron_consolidated` | `true` | 落到 evidence 检查 ⇒ `quarantine` |
| `force_demote` | 其他 source | 任意 | 不受开关影响 |

### 3.4 🔴 一条必须钉住的不变量（W3 会撞它）

fall-through 那里是 `if (Array.isArray(t2Result.evidence) && t2Result.evidence.length > 0)`，否则 `allow`。

⇒ **假如将来 `t2` 能在 evidence 为空时返回 `force_demote`，那么开关打开会把 `force_demote` 变成 `allow`** ——
一个**意图更严**的开关产生了**放松**。

**今天不可能**：`evaluateTier2`（`:62-85`）的分数只由 pattern 命中累加，而每次命中都 `evidence.push(...)`
⇒ `force_demote`（`score >= 0.35`）**蕴含 evidence 非空**。

🔴 **但 W3 的内容正是"扫描器改强"，改的就是这个打分器。**
⇒ **本设计要求实现计划把这条不变量写成测试**，注释写明 WHY：
它是"开关单调更严"的依据，**W3 一旦破坏它，这个测试先响，W1 的开关必须重审**。
（Rule 9：测试要编码"为什么重要"，不是只测"做了什么"。）

## 四、验收判据（人类 2026-08-19 定的底线）

**必须有测试在 `switch=true` 下断言行为。** 理由：本轮刚诊断出 8 个死键，
而 `block_user_explicit` 正是"值对、形状对、全绿、没人调"的样本 ——
**只加键不证明它活着，等于造第 9 个死键。**

1. **`evaluateTier3` 真值表**（单元）：覆盖 §3.3 那张表的每一行，含默认关时的回归锁。
2. **不变量测试**（§3.4）。
3. **调用点集成测试**：走真实 `save` 路径，开关打开时一条 `user_explicit` 记忆确实被 quarantine。
   **单元测试证明函数对，这条才证明它被接上了。**
4. **`diagnose` 可见性**：开关处于非默认值时必须报出来 —— 见 §六的 W0 依赖。

## 五、删死键（**独立一步、独立提交**）

人类裁决 2026-08-19：**写进 W1 计划，但单独成步、单独提交**，可单独回滚。

- 删 `security.tier3.block_user_explicit`（`config.mjs` 与 `config.default.json` 同步）。
- 🔴 **`docs/ccmem-v0.3-spec.md:1017`** 记着它的语义（`// user_explicit 永不 quarantine`）。
  **按本仓库既有做法：保留原文、划掉、加指向本文件的注记**，**不要静默删改历史 spec**。
  （规则：撤回一条说法要 grep 措辞、逐处就地改 —— 光在新章节宣布不管用，这条已栽过三次。）
- 同步更新 `specs/2026-08-14-default-config-dead-keys.md`（8 → 7）与 `specs/2026-08-19-dead-key-disposition.md`。
- **不需要迁移脚本**：用户 `config.json` 里若留着这个键，删除后只是变成被忽略的多余键。
  **计划里要明写这一句**，免得有人顺手加迁移。

## 六、依赖与时序

- 🔴 **依赖 W0（通用"非默认配置上报"机制）**：验收判据 4 要靠它。
  `admin/diagnose.mjs` **目前没有任何报告非默认配置的机制**，这是真实工作量（spec §二 W2 已指出）。
  人类 2026-08-19 选定：**抽成独立前置件 W0，W1 与 W2 共用** ⇒ 计划从三份变四份。
  **W0 先落，W1 才算验收完整。这条依赖必须同时写进 W0 与 W1 两份计划。**
- **整个 W1 等测量窗口关闭**（spec §三）。
- 落地后跑全量套件，**跑批起止时间当场记进 `plans/2026-08-10-raise-openai-timeout.md`**，不要事后回忆。

## 七、明确不做

- 不碰 `security-audit.mjs:78` 与 `tier15.mjs:141` 两处 SQL 白名单（理由见 §二）。
- 不碰 `lib/revalidation.mjs:106` —— 它**本来就不分 source**（按 trust / pinned 门控）。
  ⇒ **豁免是写入时的性质，不是全局性质**，这也是"收窄到写入时"站得住的依据。
- **不在任何生产默认值里把开关打开**。默认 `false` 是**产品理由**：
  6 条英文正则的误报会直接吞掉用户手写的记忆，而本仓库自己在 dogfood。

## 八、效力边界

- §二那张表的"实测"依据是 ⅩⅢ.3，**本设计未重跑那次调查**，只复核了 `evaluateTier3` /
  `evaluateTier2` / `save.mjs:72` / `trust.mjs:4` 四处源码。
- §3.4 的"今天不可能"依赖 `evaluateTier2` 当前实现与 `save.mjs` 是唯一调用方
  （实测 `evaluateTier3` 全仓库只有这一个调用点）。**`evaluateTier3` 是导出函数**，
  外部若手工构造 `t2Result` 传入，该论证不适用 —— 这正是要把不变量写成测试的原因。
