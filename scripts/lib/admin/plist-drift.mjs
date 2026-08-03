import { existsSync } from 'node:fs';
import path from 'node:path';

// key 分类。原则（设计文档 §四）：凡决定"daemon 用谁的身份、把数据发到哪、
// 读哪个文件"的 key，值不得静默变；凡只决定"怎么做"的 key，自由变。
//
// CCMEM_CLAUDE_P_COMMAND 是唯一的刻意例外：它决定哪个本地二进制被执行，按字面
// 也算"身份"，但归自由变 —— 它消失由 G1 挡、它指向变坏由 G4 的探针挡。
const POINTING_KEYS = new Set([
  'CCMEM_DATA_ROOT',
  'CCMEM_CONFIG_PATH',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'CLAUDE_CODE_USE_FOUNDRY'
]);

const CREDENTIAL_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_FOUNDRY_API_KEY'
]);

const FREE_KEYS = new Set([
  'PATH',
  'CCMEM_CLAUDE_P_COMMAND',
  'CCMEM_CLAUDE_P_ARGS_JSON',
  'CCMEM_CLAUDE_P_TIMEOUT_MS',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL'
]);

export function classifyKey(key) {
  if (POINTING_KEYS.has(key)) return 'pointing';
  if (CREDENTIAL_KEYS.has(key)) return 'credential';
  if (FREE_KEYS.has(key)) return 'free';
  return null;
}

export const ALL_CLASSIFIED_KEYS = [
  ...POINTING_KEYS,
  ...CREDENTIAL_KEYS,
  ...FREE_KEYS
];

const ENV_OPEN = '<key>EnvironmentVariables</key><dict>';
const PROGRAM_ARGS_RE = /<key>ProgramArguments<\/key>\s*<array>[\s\S]*?<\/array>/;

export function splitPlist(text) {
  let envText = null;
  let rest = text;

  const open = text.indexOf(ENV_OPEN);
  if (open !== -1) {
    const bodyStart = open + ENV_OPEN.length;
    const close = text.indexOf('</dict>', bodyStart);
    if (close !== -1) {
      envText = text.slice(bodyStart, close);
      rest = text.slice(0, open) + text.slice(close + '</dict>'.length);
    }
  }

  const argsMatch = rest.match(PROGRAM_ARGS_RE);
  const programArgs = argsMatch ? argsMatch[0] : null;
  const template = argsMatch ? rest.replace(PROGRAM_ARGS_RE, '') : rest;

  return { envText, programArgs, template };
}

const PAIR_RE = /<key>([^<]*)<\/key><string>([^<]*)<\/string>/g;

// escapeXml 的逆。& 必须最后还原，否则 "&amp;lt;" 会被错还原成 "<"。
function unescapeXml(value) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

export function parseEnvDict(envText) {
  if (typeof envText !== 'string') return { ok: false };

  const env = {};
  let residue = envText;

  for (const match of envText.matchAll(PAIR_RE)) {
    env[unescapeXml(match[1])] = unescapeXml(match[2]);
    residue = residue.replace(match[0], '');
  }

  // 有吃不掉的非空白残留 ⇒ 这不是我们渲染的形状，判不可解析。
  if (residue.trim() !== '') return { ok: false };

  return { ok: true, env };
}

export const EMPTY_LISTS = {
  added: [], removed: [], changed: [], benign_changed: [], template_changed: []
};

const REMEDY = 'run `ccmem admin daemon uninstall && ccmem admin daemon install` from the shell you want the daemon to inherit';

// 直接复用 loadConfig 的解析规则（config.mjs），不另发明一套：
// 比的是 daemon 实际会读哪个文件，不是字典里有没有那个 key。
export function effectiveConfigPath(env, defaultDataRoot) {
  const root = env.CCMEM_DATA_ROOT ?? defaultDataRoot;
  const userPath = env.CCMEM_CONFIG_PATH;
  return userPath && existsSync(userPath) ? userPath : path.join(root, 'config.json');
}

const POINTING_LITERAL_KEYS = ['CCMEM_DATA_ROOT', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL', 'CLAUDE_CODE_USE_FOUNDRY'];

// 设计文档 §四/§七：值一律不打印，只打印 key 名；唯一例外是 CCMEM_CONFIG_PATH 与
// CCMEM_DATA_ROOT 的新旧值——被拦下的人必须看见它想把你改指到哪才能裁决。
// effectiveConfigPath 分支（上面）已经这样报 CCMEM_CONFIG_PATH 了；这里补
// CCMEM_DATA_ROOT 的同等待遇。其余指向类 key 仍只报 key 名。
const POINTING_KEYS_WITH_VALUES = new Set(['CCMEM_DATA_ROOT', 'CCMEM_CONFIG_PATH']);

export function evaluateGates(oldEnv, newEnv, { defaultDataRoot, probe }) {
  // G1 —— key 非缩减。
  const removed = Object.keys(oldEnv).filter((key) => !(key in newEnv));
  if (removed.length) {
    return { ok: false, blocked_by: 'G1', reason: `refusing to drop ${removed.join(', ')} from the daemon environment; ${REMEDY}` };
  }

  // G2 —— 指向类有效值。CCMEM_CONFIG_PATH 指向一个不存在的文件时，
  // 有效值虽然回落成默认，但写进 plist 就是一颗延时地雷：那个文件一旦被创建，
  // daemon 下次启动就跟着走了，而它已经过了这道门。所以拦。
  if (newEnv.CCMEM_CONFIG_PATH && !existsSync(newEnv.CCMEM_CONFIG_PATH)) {
    return { ok: false, blocked_by: 'G2', reason: `CCMEM_CONFIG_PATH names ${newEnv.CCMEM_CONFIG_PATH}, which does not exist; ${REMEDY}` };
  }

  const oldConfig = effectiveConfigPath(oldEnv, defaultDataRoot);
  const newConfig = effectiveConfigPath(newEnv, defaultDataRoot);
  if (oldConfig !== newConfig) {
    return { ok: false, blocked_by: 'G2', reason: `refusing to repoint the daemon config from ${oldConfig} to ${newConfig}; ${REMEDY}` };
  }

  for (const key of POINTING_LITERAL_KEYS) {
    if ((oldEnv[key] ?? null) !== (newEnv[key] ?? null)) {
      const detail = POINTING_KEYS_WITH_VALUES.has(key)
        ? ` from ${oldEnv[key] ?? '(unset)'} to ${newEnv[key] ?? '(unset)'}`
        : '';
      return { ok: false, blocked_by: 'G2', reason: `refusing to change ${key}${detail}, which decides where the daemon sends data; ${REMEDY}` };
    }
  }

  // G3 —— 凭据类。只报 key 名，永不报值。
  for (const key of Object.keys(newEnv)) {
    if (classifyKey(key) !== 'credential') continue;
    if ((oldEnv[key] ?? null) !== newEnv[key]) {
      return { ok: false, blocked_by: 'G3', reason: `refusing to change ${key}; ${REMEDY}` };
    }
  }

  // G4 —— 探针。新 env 没有 claude 可探时空过（正常路径已被 G1 拦下），
  // 但空过不得记成"探针通过"。
  const command = newEnv.CCMEM_CLAUDE_P_COMMAND;
  if (command) {
    const probed = probe(command, newEnv);
    if (!probed.ok) {
      return { ok: false, blocked_by: 'G4', reason: probed.reason ?? 'claude capability probe failed' };
    }
  }

  return { ok: true, blocked_by: null, reason: 'all gates passed' };
}

export function comparePlist(oldText, newText) {
  const oldParts = splitPlist(oldText);
  const newParts = splitPlist(newText);

  const oldEnv = parseEnvDict(oldParts.envText);
  const newEnv = parseEnvDict(newParts.envText);

  // 判不了就是判不了。不得从解析失败推出 in_sync。
  if (!oldEnv.ok || !newEnv.ok) {
    return { status: 'unknown', ...EMPTY_LISTS };
  }

  const added = [];
  const removed = [];
  const changed = [];
  const benign_changed = [];

  for (const key of Object.keys(newEnv.env)) {
    if (!(key in oldEnv.env)) added.push(key);
  }
  for (const key of Object.keys(oldEnv.env)) {
    if (!(key in newEnv.env)) removed.push(key);
  }
  for (const key of Object.keys(newEnv.env)) {
    if (!(key in oldEnv.env)) continue;
    if (oldEnv.env[key] === newEnv.env[key]) continue;
    // 自由变 key 的值变化不进报警轴 —— 但它仍会让字节不等，从而进重写轴。
    if (classifyKey(key) === 'free') benign_changed.push(key);
    else changed.push(key);
  }

  const template_changed = [];
  if (oldParts.programArgs !== newParts.programArgs) template_changed.push('ProgramArguments');
  if (oldParts.template !== newParts.template) template_changed.push('template');

  // 自由变 key 的整体消失/出现，跟它的值变化一样不进报警轴 —— 但 added/removed
  // 仍要完整列出该 key，"消失了"这件事不能被吞掉（G1 在 Task 4 另外挡）。
  const raisesVerdict =
    added.some((key) => classifyKey(key) !== 'free') ||
    removed.some((key) => classifyKey(key) !== 'free') ||
    changed.length;
  return {
    status: raisesVerdict ? 'drifted' : 'in_sync',
    added, removed, changed, benign_changed, template_changed
  };
}
