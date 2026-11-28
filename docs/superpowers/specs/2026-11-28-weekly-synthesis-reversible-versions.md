# Reversible weekly synthesis versions

- **Scope:** ccmem issue #569; implementation starts from main `07195ae` on branch `fix/issue-569-weekly-synthesis-history` (2026-11-28).
- **Intent:** preserve every source memory byte-for-byte when weekly synthesis merges duplicates, and provide a bounded way to undo a mistaken merge.

## Approaches

1. **Keep overwriting and store full snapshots in audit details.** This preserves old content but duplicates potentially large memory text in audit JSON and requires custom restoration logic for every source.
2. **Insert a version row and link all source rows to it.** This keeps original rows intact, lets existing `status='active'` selectors expose only the current merged result, and gives one merge id for an atomic revert. **Selected:** it matches the issue's acceptance criteria and keeps recovery data in the memory rows themselves.
3. **Add a separate merge-history table.** This models merge events explicitly, but adds another table and migration while the memory row links already express the one-step parent and successor relationship needed here.

## Design

- Migration 022 adds `version INTEGER NOT NULL DEFAULT 1`, `root_id`, `parent_id`, and `superseded_by` to `memories`; existing rows retain version 1 and null links. The migration is additive and includes rollback SQL/instructions.
- For each accepted `merged_duplicates` item, weekly synthesis inserts one new memory row based on the first selected source's metadata, with merged content, `version = max(source versions) + 1`, `root_id` set to the earliest source lineage root, and `parent_id` set to the first source id. It then marks every source `superseded` and points each `superseded_by` at the new row. The changes and `synthesis_dedup_merged` audit record are atomic. Rejected/refiner-failed merges write no versions and change no source rows.
- `ccmem revert <id>` accepts a current merged version only when it has source rows pointing to it, has no successor, and its decay state is `active` or `probation`. In one immediate transaction it marks the merged row superseded, restores all directly linked sources to active, records `memory_reverted`, and rebuilds the affected injection cache. A row with a successor, an archived/expired decay state, or an incomplete/unlinked version is refused, preventing forks or undoing a deliberate hide/expiry.
- Retrieval continues to select only active rows. The merge row is therefore the sole visible version until reverted, when its sources become visible again.

## Goals and limits

- Preserve source content exactly and make the latest merge reversible without editing or deleting memory rows.
- Keep the user-visible memory count increasing by one for a merge of existing rows; do not change export columns or retrieval status filters.
- This recovery applies to merges written after migration 022. Historical rows already overwritten on older schema versions cannot be reconstructed from the 80-character audit excerpt.
- Do not run migrations, synthesis, or writes against the production database or daemon during implementation; all verification uses temporary data roots.

## Verification

- A three-source merge adds one row, leaves all three original contents byte-identical, points every source's `superseded_by` to the new row, and exposes only the merge through active selectors.
- Reverting that row restores all three sources, supersedes the merged row, returns retrieval to the pre-merge sources, and writes an audit record.
- Reverting a row with a successor or a non-merge row fails without modifying memory, audit, or cache state.
- Migration tests cover version-21 to 22 and the documented rollback path on an isolated database copy.
