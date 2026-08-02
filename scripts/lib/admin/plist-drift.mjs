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
