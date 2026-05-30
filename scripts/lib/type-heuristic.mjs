const RULE_TRIGGERS = [
  '必须',
  '务必',
  '不要',
  '一律',
  '统一',
  'always use',
  'must use',
  'never use',
  'prefer'
];

export function inferType(content) {
  const lower = content.toLowerCase();

  for (const trigger of RULE_TRIGGERS) {
    if (lower.includes(trigger.toLowerCase())) {
      return {
        type: 'rule',
        triggered_by: trigger
      };
    }
  }

  return {
    type: 'fact',
    triggered_by: null
  };
}
