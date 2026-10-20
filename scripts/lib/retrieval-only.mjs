// A memory tagged `retrieval_only` reaches a session only through per-prompt
// retrieval: it is kept out of the injection cache (the one source of the
// session-start stable section) and out of the daemon passes that would carry
// it there indirectly (weekly consolidation, cross-project promotion). Orca's
// corrections are written this way (human: "只在文档相关内容时才被检索出来";
// spec docs/superpowers/specs/2026-10-21-orca-correction-import-design.md §4).
export const RETRIEVAL_ONLY_TAG = 'retrieval_only';

// SQL predicate, true when the row is NOT retrieval-only. `alias` is the
// memories table alias ('' for none). NULL or malformed tags count as not
// tagged, so legacy rows keep today's behaviour.
export function notRetrievalOnlySql(alias = '') {
  const tags = alias ? `${alias}.tags` : 'tags';
  return `NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${tags}) THEN ${tags} ELSE '[]' END) WHERE value = '${RETRIEVAL_ONLY_TAG}')`;
}
