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
