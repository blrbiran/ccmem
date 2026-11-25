# Lexical retrieval matches any term, and the relevance gate sees both signals (FTS AND→OR with #453) — design

Status: **draft for the human's review; no code.** Author: Orca session `6add92a5` (Claude Opus 5.5), 2026-11-25, on
ccmem main after `fix(diagnose): read Codex's trust table headers segment by segment…`. Human (Orca session `d7ca40c0`,
2026-11-24): FTS AND→OR is designed together with #453's gate, separately (「以后单独设计」, agreed).

## 1. Problem (read from code, this session)

- `sanitizeFtsQuery` (`scripts/lib/retrieval.mjs:24`) quotes up to 20 tokens and joins them with spaces. In FTS5 that is
  an implicit **AND**: a memory matches only if it holds every token of the prompt. A natural-language prompt of 10–20
  words almost never matches, so the FTS weight (0.4 of the fused score) is near zero in practice and the lexical side
  falls through to the LIKE fallback (`like_fallback.trigger_when_fts_below: 3`).
- #453's gate (`retrieval.mjs:536-540`, `min_cosine_by_signature`, bge-m3 0.60) drops rows by **cosine alone**. A row a
  prompt names word-for-word but whose embedding scores below the floor is dropped, whatever its lexical match.
- The embedding-free path (`lexicalRetrieve`, `B-off` / `B-circuit`) has no gate at all.

Switching to OR alone would flood the candidates with rows sharing one common word; keeping the cosine-only gate would
then throw away the lexical wins OR was meant to add. Hence one design.

## 2. Design

1. **OR query over discriminative tokens.** `sanitizeFtsQuery` joins quoted tokens with ` OR `. Tokens are filtered
   first by a small built-in stop list (en + zh function words) and by document frequency: a token present in more than
   `retrieval.fts.max_df_ratio` (default 0.2) of the project's memories is dropped (one `fts5vocab` read, cached per
   process for a minute). BM25 already ranks rows holding more terms higher.
2. **Lexical evidence = matched-term count.** For each FTS row, the number of distinct prompt tokens it holds (from the
   tokens already computed for Jaccard) is kept as `ftsTerms`.
3. **The gate keeps a row if either signal clears its bar**: `cosine >= floor` (as #453) **or**
   `ftsTerms >= retrieval.gate.min_fts_terms` (default 2, and at least 30 % of the discriminative tokens when the prompt
   has more than 6). A model with no calibrated floor keeps today's behaviour for the cosine half.
4. **The embedding-free path gets the lexical half of the same gate** (it has no cosine), so `B-off` stops returning a
   LIKE row that shares one word with the prompt.
5. Dedup (`dedup.mjs:66`) keeps an AND query: it asks "is this the same memory", not "is this relevant". It gets its own
   function (`sanitizeFtsQueryAll`) so the change does not move dedup decisions.

## 3. Calibration (before any default ships)

Reuse #453's method on a **copy** of the real store (never the live one): the same 80 real prompts + 24 off-topic ones.
Report, per setting of `min_fts_terms` ∈ {1, 2, 3} and `max_df_ratio` ∈ {0.1, 0.2, 0.3}: off-topic rows kept,
real prompts emptied, and real prompts that gain a row the cosine-only gate dropped. Pick the setting that keeps
off-topic rows at or below #453's 1/144 while gaining real rows; record the numbers in the spec before changing defaults.

## 4. Criteria (each exits 0 / non-0)

1. A memory holding 3 of a 12-word prompt's words is an FTS candidate (red today: AND).
2. A stop-word-only or high-df-only overlap yields no FTS candidate.
3. A row below the cosine floor with `ftsTerms >= 2` is kept; one with `ftsTerms = 1` is dropped.
4. `B-off` applies the lexical gate (a single-word LIKE overlap is dropped).
5. Dedup decisions on the existing dedup fixtures are byte-for-byte unchanged.

## 5. Open questions (recommended answers)

1. Defaults before calibration: ship OR + gate behind `retrieval.fts.mode: "and" | "or"` defaulting to `and`, flip
   after the calibration numbers are recorded. (Recommended: yes — the live hook path is latency- and noise-sensitive.)
2. CJK prompts: `ftsTokens` splits on whitespace, so a Chinese prompt is one token. Use the existing `Intl.Segmenter`
   tokenizer (`tokenize`) for FTS too? Recommended yes, in the same change, measured in the calibration.

## Calibration (session 5d3d0c09, 2026-11-25)

Implemented on branch `feat/fts-or-switch` (commit `feat(retrieval): FTS OR mode and a two-signal relevance gate
behind retrieval.fts.mode, default "and" (FTS OR switch)`). Keys: `retrieval.fts.mode` (`"and"` default),
`retrieval.fts.max_df_ratio` (0.2), `retrieval.gate.min_fts_terms` (2). **The default was not changed.**

**As built, where it differs from §2.** (a) Document frequency is one substring-count scan of the retrievable
memories, not `fts5vocab`: `memories_fts` uses the trigram tokenizer, whose vocabulary is trigrams, not words.
(b) No per-process cache: hooks are a new process per prompt, so it would never hit; the scan measured below.
(c) Tokens come from `tokenize` (open question 2: yes) — CJK goes through `Intl.Segmenter`; words under 3
characters stay as lexical evidence but are not put in the MATCH (trigram matches nothing shorter). (d) Term hits
are counted by substring, the same test the trigram index applies. (e) `sanitizeFtsQuery` is unchanged (it is the
"and" query), so dedup needed no new function; criterion 5 holds structurally.

**Method.** A `sqlite3 .backup` copy of the live store (19,633 memories; 16,937 active; 17,105 bge-m3 vectors),
opened under a private `CCMEM_DATA_ROOT`; the live store was only read by the backup API. The #453 prompt files
were not kept, so the sets were rebuilt: 80 real prompts (distinct user prompts from local Claude Code
transcripts, round-robin over 11 transcript directories, newest first; 62 contain CJK) and 24 hand-written
off-topic prompts (12 en, 12 zh; cooking, sport, travel, pets…), run against the project with the most real
prompts (10,409 retrievable memories). Every run uses the prompt hook's call (`relevanceFloor: true`), bge-m3 via
local Ollama, floor 0.60. "Gained" = a returned row whose cosine is below 0.60 (kept only by the lexical half).
Nothing here is relevance-labelled: a gained row is not known to be a useful row. Runner scripts were scratch
files; the prompts are user data and were deleted with the copy.

**Embedding path (A), 24 off-topic prompts = 144 slots.**

| setting | off-topic rows kept | real prompts emptied | real prompts with an FTS hit | real prompts gaining a row (rows) |
|---|---|---|---|---|
| today: `and`, cosine-only gate | **0/144** | 6/80 | 0/80 | — |
| `or` df 0.1, min 1 | 90/144 | 4/80 | 55 | 14 (48) |
| `or` df 0.1, min 2 | 16/144 | 5/80 | 53 | 10 (20) |
| `or` df 0.1, min 3 | 3/144 | 6/80 | 53 | 4 (5) |
| `or` df 0.2, min 1 | 86/144 | 4/80 | 58 | 12 (41) |
| `or` df 0.2, min 2 (design default) | 18/144 | 5/80 | 57 | 10 (24) |
| `or` df 0.2, min 3 | 5/144 | 5/80 | 57 | 6 (15) |
| `or` df 0.3, min 1 | 80/144 | 4/80 | 58 | 12 (41) |
| `or` df 0.3, min 2 | 23/144 | 5/80 | 57 | 10 (24) |
| `or` df 0.3, min 3 | 5/144 | 5/80 | 57 | 6 (15) |

The off-topic rows kept lexically are not a CJK artefact: at df 0.2/min 2 (18 rows from 5 prompts) and df 0.1/min 3
(3 rows, 1 prompt) every such row was matched by at least one ASCII word of 3+ characters.

**Embedding-free path (B-off)** (copy's `config_kv` `embedding.enabled` set to false, in the copy only).

| setting | off-topic rows kept | real prompts emptied | real rows | real prompts with an FTS hit |
|---|---|---|---|---|
| today: `and`, no gate | 140/144 | 0/80 | 480 | 0 |
| `or` df 0.1, min 1 | 89/144 | 51/80 | 110 | 28 |
| `or` df 0.1, min 2 | 16/144 | 55/80 | 74 | 25 |
| `or` df 0.1, min 3 | 3/144 | 60/80 | 42 | 20 |
| `or` df 0.2, min 1 | 85/144 | 51/80 | 106 | 29 |
| `or` df 0.2, min 2 | 18/144 | 53/80 | 89 | 27 |
| `or` df 0.2, min 3 | 5/144 | 57/80 | 60 | 23 |
| `or` df 0.3, min 1 | 79/144 | 51/80 | 106 | 29 |
| `or` df 0.3, min 2 | 23/144 | 53/80 | 89 | 27 |
| `or` df 0.3, min 3 | 5/144 | 57/80 | 60 | 23 |

**Cost of the df scan** (104 prompts, on the copy, load average 9–58 during the run): p50 60 ms, p90 84–86 ms,
max 137–143 ms per prompt, for every df setting; median 13 discriminative words, median 4 of them long enough
for the MATCH; 14–15 of 104 prompts have no MATCH word at all.

**Reading.** The AND finding is confirmed: 0/80 real prompts get any FTS hit today; OR gives 53–58/80 one.
But §3's rule — keep off-topic rows at or below #453's 1/144 while gaining real rows — is **met by no setting**:
today's path A keeps 0/144 off-topic on this prompt set, and every OR setting keeps more (best 3/144 at df 0.1,
min 3, which gains 4 real prompts / 5 rows, unlabelled). On the embedding-free path the gate does cut off-topic
rows 140→16–18/144, but empties 53–55/80 real prompts that today get rows (relevance of those rows unknown).

**Recommended thresholds, if the switch is turned on at all:** `max_df_ratio` 0.1, `min_fts_terms` 3 (lowest
off-topic leak in both paths). **Recommendation: do not flip the default.** The numbers do not show a win the
cosine-only gate lacks, and the human ruling requires one before a default change. Worth doing before
revisiting: label a sample of the gained rows (are they useful?), and consider applying the lexical gate only on
the embedding-free path, where today's 140/144 off-topic leak is the real problem.
