# Orca corrections in ccmem: idempotent import, withdrawal, retrieval only — design

- **Author:** Orca session `9ec98639` (2026-10-21), track F. **Status:** design + as-built in the same round.
- **Mirrors:** Orca `docs/superpowers/specs/2026-10-21-corrections-to-ccmem-design.md` §2–§3 (Orca's half: which
  corrections, when, the memory text). This spec is ccmem's half: how ccmem stores them.
- **Rulings:** human, Orca session `308b874c`: retrieval only — "只在文档相关内容时才被检索出来". Human, Orca session
  `9ec98639`: "这一轮先不做需要brainstorm的工作" / "先按你的建议执行" — the choices below are the controller's,
  recorded under §7.

## 1. Intent

A correction is the person overriding an agent's choice in Orca. Once it is closed (and not withdrawn), Orca writes it
into ccmem so the person's own sessions in that repository can retrieve it. Re-sending the same correction must never
duplicate it; withdrawing it must remove it from retrieval without a raw delete; and it must never be part of the
session-start stable context — only per-prompt retrieval surfaces it.

## 2. CLI contract (what Orca calls)

Two subcommands. Both read **one JSON object on stdin**, run with **cwd = the target repository** (the project key is
resolved from cwd by ccmem's own `resolveProjectKey`, exactly as `ccmem export --scope project` does — one rule, no
key passed in), and print **one JSON object on stdout**.

```
ccmem orca-correction upsert     < {"version":1,"id":"<orca correction id>","content":"<memory text>"}
ccmem orca-correction withdraw   < {"version":1,"id":"<orca correction id>"}
```

Input schema (strict: unknown keys refused):
- `version`: the integer `1`.
- `id`: non-empty string, ≤ 200 chars, no whitespace or control characters (it becomes part of a tag).
- `content` (upsert only): non-empty string, at most `save.max_chars_per_memory` characters (default 500) — the same
  limit every memory has. Orca's template must fit it.

Output:
- upsert: `{"action":"inserted"|"unchanged"|"superseded","memoryId":<n>,"externalRef":"orca:correction:<id>",
  "projectKey":"<key>","decayStatus":"active"|"quarantine"}`.
  - `unchanged`: a current row with this ref in this project already has byte-identical content; nothing written.
  - `superseded`: the current row's content differs; it is archived (audit `orca_correction_superseded`) and a new row is
    inserted in the same transaction. `memoryId` is the new row.
  - `decayStatus: "quarantine"`: ccmem's write-time threat scan quarantined it (same rule as every external write).
- withdraw: `{"action":"withdrawn"|"absent","memoryIds":[...],"externalRef":"…","projectKey":"…"}` — every non-archived
  row with the ref in this project is archived (audit `orca_correction_withdrawn`); `absent` when none.

Exit codes:
- `0` — done (any action above).
- `64` — input refused: not JSON, schema violation, content over the limit, or the write gate (tier 1) rejected the
  text. **Retrying the same input will not help.**
- `1` — anything else (e.g. database busy). **Retry later.**

## 3. Storage (no schema migration)

- `source = 'external'` (the `memories.source` CHECK constraint allows six values; a new value would need a table
  rebuild migration, and it would change `ccmem export`'s `source` enum, which Orca parses strictly — handoff §6.1).
- Distinction is by tags: `["orca-correction", "orca:correction:<id>", "retrieval_only"]`.
- `scope = 'project'`, `type = 'rule'`, `trust_score = 0.8` set explicitly (§7.2).
- Idempotency key = (`project_key`, tag `orca:correction:<id>`) over rows whose `decay_status` is not `archived`.
  The lookup and the write run in one `BEGIN IMMEDIATE` transaction, so two concurrent upserts cannot both insert.
- Withdrawal and supersession set `decay_status = 'archived'` (what `resurrect … forget` already does): out of every
  retrieval and cache query, still on disk, auditable. Never `DELETE`.
- `embedSync: false`: the vector comes from the daemon's `vec_backfill`, like `ccmem import`; FTS/LIKE retrieval works
  immediately.

## 4. Retrieval only — the `retrieval_only` tag

A row tagged `retrieval_only` is excluded wherever ccmem would carry it into context **other than** per-prompt
retrieval:
1. `rebuildInjectionCache` (both the global and the project select) — this is the single source of the session-start
   stable section (`selectStableRows` reads only `injection_cache.member_ids`), for the file-based context and the
   legacy SessionStart text alike, and for the prompt-submit rewrite of the stable section.
2. `weekly-synthesis` project batch — otherwise a consolidated row built from it would enter the stable section.
3. `cross-project-patterns` project rows — otherwise it could be promoted to a global row.

Per-prompt retrieval (FTS, LIKE, legacy substring, vector) is unchanged and sees these rows. The predicate lives in one
place (`scripts/lib/retrieval-only.mjs`) and tolerates `NULL` or malformed `tags`.

## 5. Export impact (Orca)

None to Orca's parser: `version` stays `0.7`, columns unchanged, `source` is `external` (an existing enum value),
`tags` is a JSON string array, `trust_score` a number. The Memory page will show these rows with source `external` and
the `orca-correction` tag. Nothing for Orca to change in its export reader.

## 6. Effect on running processes

- CLI and hooks: live once merged (hooks run the main tree via the plugin symlink).
- **Daemon:** `weekly-synthesis`, `cross-project-patterns` and the daemon's own cache rebuilds run daemon code ⇒ until the
  daemon restarts, a daemon-side cache rebuild or synthesis would still include these rows. **Orca must not start
  exporting corrections until the human has restarted the daemon** on a commit containing this change (the same
  restart track B's fixes need).

## 7. Decisions (controller's calls, reversible)

1. New subcommand instead of a flag on `ccmem import <file>`: `import` reads a whole export file and always inserts;
   overloading it with keyed upsert and withdrawal would change what `import` means for its existing callers.
2. Initial trust **0.8**: the person's own ruling, curated, like `cerebrum_import` (0.8); below `user_explicit` (0.9)
   because the text is Orca's template, not words the person typed into this tool; well above `external` (0.3), which
   would rank it below almost everything. A constant in code, not a new config key.
3. `type = 'rule'`: a correction tells the next agent what to do instead.
4. Project key from cwd, not from the input: guarantees the key equals what the person's own sessions in that checkout
   compute (including local-clone following); Orca already runs `ccmem export` with cwd = target repository.
5. Supersede by archive + insert rather than updating in place: reuses the one insert path (threat scan, FTS triggers,
   injection cache) and leaves an audit trail.
6. A quarantined-at-write current row counts as current for idempotency (no duplicate quarantined rows on re-send).

## 8. Tests (red first; each new branch has a named mutation seen red in a `git clone --local` copy)

`tests/integration/orca-correction.test.mjs`, CLI-level against a temp git repo with an https origin and a relocated
data root: insert; identical re-send ⇒ `unchanged` and one row; changed content ⇒ `superseded`, old row archived with
audit; withdraw ⇒ archived, `absent` on repeat; never `DELETE` (row count); not in the stable section
(`selectStableRows` / injection cache) while an ordinary project memory is; retrieved per prompt (FTS); export shape
unchanged (`source` external, tags carry the ref); schema refusals exit 64; over-limit exit 64; weekly-synthesis and
cross-project selectors skip `retrieval_only`.

## 9. Residuals

- `contradiction-audit` still reads these rows (audit only; it may propose actions on them like any project memory).
- A person can still `promote` such a row to global by hand — their act.
- Orca-side: the text template, the catch-up pass, and recording "exported" per correction (Orca spec §5).
