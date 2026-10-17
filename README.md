# ccmem

Cross-session memory for Claude Code, Codex CLI, and oh-my-pi (OMP), backed by SQLite.

ccmem stores reusable facts, rules, and episodes, injects relevant context into future sessions, and optionally runs a background daemon for heavier maintenance and synthesis tasks.

## Requirements

- Claude Code (primary), and optionally Codex CLI or OMP (see below)
- Node.js 22.5+ 
- macOS if you want `ccmem admin daemon install` (the current daemon installer targets `launchd`)

ccmem uses Node's built-in `node:sqlite`. The required Node flags are handled by the launcher, hooks, and daemon startup paths.

## Installation

### Official Claude Code marketplace

If `ccmem` is listed in the official Claude Code marketplace, install it from Claude Code with `/plugin install` and select the marketplace entry for `ccmem`.

The exact slug is controlled by Claude Code's marketplace listing UI, so use the install target shown there.

### Community marketplace

If you are testing a community listing instead:

```text
/plugin marketplace add anthropics/claude-plugins-community
/plugin install @claude-community/ccmem
```

### Temporary local debugging

To load the plugin directly from a local checkout for development:

```bash
claude --plugin-dir /absolute/path/to/ccmem
```

If you also want to run the `ccmem` CLI directly from your shell while iterating, add the launcher to a directory on your `PATH`:

```bash
ln -sf /absolute/path/to/ccmem/bin/ccmem /usr/local/bin/ccmem
```

The launcher supports symlink-based installs.

## What gets installed

- Plugin manifest: `.claude-plugin/plugin.json`
- Slash commands: `commands/*.md`
- Hooks: `hooks/hooks.json`
- CLI launcher: `bin/ccmem`
- Runtime code: `scripts/**`

User data lives outside the plugin directory under `~/.claude/ccmem/`.

## Basic usage

### Save a memory

```bash
ccmem save "Prefer concise answers"
ccmem save "Always verify prod SQL against a real database" --global
```

### List memories

```bash
ccmem list
ccmem list --quarantined
```

### Change mode

```bash
ccmem mode
ccmem mode shadow
ccmem mode off
ccmem mode active
```

### Check runtime status

```bash
ccmem stats
ccmem admin daemon status
ccmem admin diagnose
```

### Promote or review memories

```bash
ccmem promote 12
ccmem promote 12 --global
ccmem resurrect
ccmem resurrect --quarantined
ccmem resurrect --alerts
```

## Codex CLI and OMP

Claude Code uses the plugin. Codex and OMP are wired in with an explicit install command; the data root stays `~/.claude/ccmem/` (or `CCMEM_DATA_ROOT`).

The `node` binary recorded in the installed hooks/extension is the one that ran `ccmem install` (`process.execPath`), so run it with the Node you want them to use.

### Codex

```bash
ccmem install codex
ccmem uninstall codex
```

- `install` writes `${CODEX_HOME:-~/.codex}/hooks.json` (never `config.toml`), backs up an existing file to `hooks.json.bak.<ms>`, and records what it added in `<dataRoot>/installs/codex.json`. It refuses when `config.toml` defines `[hooks]`.
- Then open Codex and approve the three ccmem hooks (SessionStart, UserPromptSubmit, Stop) with `/hooks`. ccmem never bypasses Codex's hook trust. Approval is needed again whenever the hook definitions change (for example after a reinstall with a different `node`).
- `uninstall` restores the backup or strips exactly what install added. Removing an entry can shift hook indices and revoke trust of user hooks added after ccmem in the same event. Trust records stay in `config.toml`.

### OMP

```bash
ccmem install omp
ccmem uninstall omp
```

- `install` writes `<agent dir>/extensions/ccmem.ts` and records it in `<dataRoot>/installs/omp.json`. The agent dir is `CCMEM_OMP_AGENT_DIR`, else OMP's own rules (profile, `PI_CODING_AGENT_DIR`), else `~/.omp/agent`. Install prints the path it used.

### Injection

Session start injects one short instruction to read a per-session file, `.ccmem/context-<session>.md`. That file holds the stable rules and the retrieved memories, bounded (stable section 4096 bytes, of which 2048 for the project share; whole file 12288 bytes). This applies to Claude Code too.

### Background LLM backend

The daemon's summarization and synthesis tasks run through `llm.backend` (`claude`, `codex`, or `omp`). Related config: `llm.backend_order`, `llm.models` (codex defaults to `gpt-6-luna`; use `""`, not `null`, to drop `-m`), `llm.commands`.

```bash
ccmem admin llm status
ccmem admin llm use codex
ccmem admin llm order claude,codex,omp
ccmem admin llm approve
ccmem admin llm reject
```

- When a backend is exhausted (usage limit or a long retry-after), ccmem opens a failover proposal and shows a notice in the context file and at session start. It never switches backend without `ccmem admin llm approve`; returning to the preferred backend after its reset time is automatic. Short claude 429s are plain rate limits, not exhaustion.
- After changing `llm.backend`, re-run `ccmem admin daemon install`; until then `daemon status` reports PATH as `benign_changed`.
- Known gap: the Codex summarizer still loads `$CODEX_HOME/AGENTS.md`.

### Notes

- Summarized output is never silently truncated: an over-long result is rewritten by the refiner or rejected with an audit row (`summarize_refine_rejected`, `monthly_meta_refine_rejected`, `weekly_synthesis_refine_rejected`, `contradiction_merge_refine_rejected`).
- `ccmem list` and `ccmem show` display each memory's `origin_agent`. `ccmem export` does not include it (Orca's export schema is strict).

## Daemon management

The daemon is optional.

- Tier 1 and Tier 1.5 behavior still work without it.
- Tier 2 behavior depends on it.

Install and manage the daemon with:

```bash
ccmem admin daemon install
ccmem admin daemon status
ccmem admin daemon restart
ccmem admin daemon stop
ccmem admin daemon uninstall
```

`ccmem admin daemon status` may show `running=none`. That is normal when the daemon is alive but currently idle.

## Notes

- `ccmem admin daemon install` currently writes a user `launchd` agent on macOS.
- The daemon status command reports the currently running task if one exists; otherwise it reports `running=none`.
- The launcher suppresses Node's `ExperimentalWarning` output for normal ccmem CLI, hook, and daemon usage.
