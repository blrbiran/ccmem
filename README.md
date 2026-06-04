# ccmem

Cross-session memory for Claude Code, backed by SQLite.

ccmem stores reusable facts, rules, and episodes, injects relevant context into future sessions, and optionally runs a background daemon for heavier maintenance and synthesis tasks.

## Requirements

- Claude Code
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
