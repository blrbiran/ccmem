import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  backupFile,
  ensureDir,
  lineDiff,
  manifestPath,
  readManifest,
  removeManifest,
  writeManifest,
  writeOwnedFile
} from './manifest.mjs';

/**
 * `ccmem install|uninstall codex`: adds ccmem's three hooks to
 * `${CODEX_HOME}/hooks.json` (the Claude-shaped `{ "hooks": { <Event>: [...] } }`
 * file Codex discovers next to config.toml) and removes exactly them again.
 *
 * config.toml is never edited. Codex keeps its hook trust state there
 * (`[hooks.state."<key>"] trusted_hash = ...`), and the trust gate is the
 * human's: ccmem never writes trusted_hash and never bypasses the gate. The
 * human approves the hooks in Codex's `/hooks` view.
 */

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// [Codex event, hook.mjs mode, Codex trust-key label (hooks/src/lib.rs hook_event_key_label)]
const EVENTS = [
  ['SessionStart', 'session-start', 'session_start'],
  ['UserPromptSubmit', 'prompt-submit', 'user_prompt_submit'],
  ['Stop', 'stop', 'stop']
];

// Codex runs a command hook through `$SHELL -lc <command>`, and the command
// format below is unquoted, so a path a shell would split or expand would run
// something else. Refuse rather than write a hook that silently misfires.
const SHELL_SAFE_PATH = /^[A-Za-z0-9_./@+:,=-]+$/;

export function getCodexHome() {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

export function codexEntries({ repoRoot, execPath }) {
  return EVENTS.map(([event, mode]) => ({
    event,
    group: {
      hooks: [{
        type: 'command',
        command: `${execPath} --no-warnings --experimental-sqlite ${repoRoot}/scripts/hook.mjs ${mode} --agent codex`,
        timeout: 5
      }]
    }
  }));
}

function splitTomlKey(key) {
  return (key.match(/"[^"]*"|'[^']*'|[^.]+/g) ?? [])
    .map((part) => part.trim().replace(/^(["'])(.*)\1$/, '$2'))
    .filter((part) => part !== '');
}

/**
 * Finds hook *definitions* in config.toml text without a TOML parser: a table
 * header under `hooks` (`[hooks.Stop]`, `[[hooks.SessionStart]]`, ...) or a key
 * under `hooks` (`SessionStart = ...` inside `[hooks]`, `hooks.Stop = ...` or
 * `hooks = {...}` at the root). `hooks.state` is Codex's own trust record, not
 * a definition, so it never counts. Returns `[{ line, text }]` (1-based line).
 *
 * Known blind spot of the line scan: a multi-line array or string whose
 * continuation line starts with `[` is read as a table header.
 */
export function findTomlHookDefinitions(text) {
  const found = [];
  let table = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      return;
    }

    let keyPath;
    if (line.startsWith('[')) {
      const header = /^\[\[?([^\]]*)\]/.exec(line);
      table = splitTomlKey(header ? header[1] : '');
      keyPath = table;
      if (keyPath.length < 2) {
        // A bare `[hooks]` header defines nothing by itself; its keys decide.
        return;
      }
    } else {
      const eq = line.indexOf('=');
      if (eq === -1) {
        return;
      }
      keyPath = [...table, ...splitTomlKey(line.slice(0, eq))];
    }

    if (keyPath[0] === 'hooks' && keyPath[1] !== 'state') {
      found.push({ line: index + 1, text: line });
    }
  });

  return found;
}

function parseHooksFile(text, file) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${error.message}); fix or move it, then re-run`);
  }

  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(parsed) || (parsed.hooks !== undefined && !isObject(parsed.hooks))) {
    throw new Error(`${file} is not a Codex hooks file ({ "hooks": { <Event>: [...] } }); fix or move it, then re-run`);
  }

  for (const [event] of EVENTS) {
    const groups = parsed.hooks?.[event];
    if (groups !== undefined && !Array.isArray(groups)) {
      throw new Error(`${file}: hooks.${event} is not an array; fix or move it, then re-run`);
    }
  }

  return parsed;
}

function serialize(hooksFile) {
  return `${JSON.stringify(hooksFile, null, 2)}\n`;
}

/** Drops empty event arrays so "never had SessionStart" equals "SessionStart: []". */
function normalized(hooksFile) {
  const hooks = Object.fromEntries(
    Object.entries(hooksFile.hooks ?? {}).filter(([, groups]) => !(Array.isArray(groups) && groups.length === 0))
  );
  return { ...hooksFile, hooks };
}

function hasGroup(hooksFile, { event, group }) {
  return (hooksFile.hooks?.[event] ?? []).some((candidate) => isDeepStrictEqual(candidate, group));
}

/** Codex's trust-state key for each ccmem hook (hooks/src/lib.rs hook_key). */
function hookKeys(target, hooksFile, entries) {
  return entries.map((entry) => {
    const label = EVENTS.find(([event]) => event === entry.event)[2];
    const groupIndex = hooksFile.hooks[entry.event].findIndex((candidate) => isDeepStrictEqual(candidate, entry.group));
    return `${target}:${label}:${groupIndex}:0`;
  });
}

// `writeFile` is a seam for the failure tests; callers leave it at the default.
export function installCodex({ codexHome, dataRoot, repoRoot, execPath, writeFile = writeOwnedFile }) {
  for (const value of [execPath, repoRoot]) {
    if (!SHELL_SAFE_PATH.test(value)) {
      throw new Error(`refusing to install: ${JSON.stringify(value)} contains characters a shell would split or expand`);
    }
  }

  const target = path.join(codexHome, 'hooks.json');
  const configToml = path.join(codexHome, 'config.toml');
  if (existsSync(configToml)) {
    const definitions = findTomlHookDefinitions(readFileSync(configToml, 'utf8'));
    if (definitions.length > 0) {
      const lines = definitions.map(({ line, text }) => `  line ${line}: ${text}`).join('\n');
      throw new Error(
        `refusing to install: ${configToml} already defines hooks in a [hooks] table:\n${lines}\n` +
        `Codex would load both that table and ${target}. Move those hooks into ${target} ` +
        '(or remove them), then re-run. ccmem never edits config.toml.'
      );
    }
  }

  const entries = codexEntries({ repoRoot, execPath });
  const beforeText = existsSync(target) ? readFileSync(target, 'utf8') : null;
  const before = beforeText === null ? { hooks: {} } : parseHooksFile(beforeText, target);
  const manifest = readManifest(dataRoot, 'codex');

  if (manifest) {
    if (isDeepStrictEqual(manifest.entries, entries) && entries.every((entry) => hasGroup(before, entry))) {
      return { changed: false, diff: '', backup: null, hookKeys: hookKeys(target, before, entries) };
    }

    throw new Error(
      `a ccmem install recorded in ${manifestPath(dataRoot, 'codex')} does not match what would be written now ` +
      `(moved repo, another node, or ${target} edited); run \`ccmem uninstall codex\` first`
    );
  }

  if (entries.some((entry) => hasGroup(before, entry))) {
    throw new Error(
      `${target} already contains ccmem hooks that ccmem has no install record for; ` +
      'remove them by hand, then re-run'
    );
  }

  const after = structuredClone(before);
  after.hooks ??= {};
  for (const { event, group } of entries) {
    // Appended, never inserted: Codex keys trust by group index, so shifting a
    // foreign hook would silently revoke the human's approval of it.
    (after.hooks[event] ??= []).push(group);
  }
  const afterText = serialize(after);

  ensureDir(codexHome);
  const backup = beforeText === null ? null : backupFile(target);
  const backupNote = backup ? `; its previous bytes are backed up at ${backup}` : '';
  // The manifest goes down before the hooks file: if writing the hooks file
  // fails, uninstall still knows about the backup and restores it.
  try {
    writeManifest(dataRoot, 'codex', {
      target,
      createdFile: beforeText === null,
      backup,
      entries,
      installedAt: Date.now()
    });
  } catch (error) {
    throw new Error(`could not record the install (${error.message}); ${target} was not changed${backupNote}`);
  }
  try {
    writeFile(target, afterText);
  } catch (error) {
    throw new Error(
      `writing ${target} failed (${error.message})${backupNote}; the install is recorded in ` +
      `${manifestPath(dataRoot, 'codex')}: run \`ccmem uninstall codex\` to restore`
    );
  }

  // Diffed against the pretty-printed original so the human sees the hooks
  // that were added, not a reformatting; the original bytes are in `backup`.
  const diff = lineDiff(beforeText === null ? '' : serialize(before), afterText);
  return { changed: true, diff, backup, hookKeys: hookKeys(target, after, entries) };
}

export function uninstallCodex({ codexHome, dataRoot }) {
  const manifest = readManifest(dataRoot, 'codex');
  if (!manifest) {
    return { changed: false, restored: false };
  }

  const target = path.join(codexHome, 'hooks.json');
  if (manifest.target !== target) {
    throw new Error(`the ccmem install record is for ${manifest.target}, not ${target}; set CODEX_HOME to match`);
  }

  if (!existsSync(target)) {
    removeManifest(dataRoot, 'codex');
    return { changed: false, restored: false };
  }

  let current;
  try {
    current = parseHooksFile(readFileSync(target, 'utf8'), target);
  } catch (error) {
    // A damaged file after a recorded merge is most likely ccmem's own failed
    // write (install wrote the backup first). Keep the damaged bytes, then put
    // the original back. Without a backup there is nothing safe to restore.
    if (manifest.createdFile || !existsSync(manifest.backup)) {
      throw error;
    }
    const damagedBackup = backupFile(target);
    writeOwnedFile(target, readFileSync(manifest.backup));
    removeManifest(dataRoot, 'codex');
    return { changed: true, restored: true, damagedBackup };
  }

  const stripped = structuredClone(current);
  const missing = [];
  for (const { event, group } of manifest.entries) {
    const groups = stripped.hooks?.[event];
    const index = groups?.findIndex((candidate) => isDeepStrictEqual(candidate, group)) ?? -1;
    if (index === -1) {
      missing.push(event);
      continue;
    }

    groups.splice(index, 1);
    if (groups.length === 0) {
      delete stripped.hooks[event];
    }
  }
  const removedAny = missing.length < manifest.entries.length;

  let originalBytes = null;
  if (!manifest.createdFile) {
    if (!existsSync(manifest.backup)) {
      throw new Error(`the backup ${manifest.backup} is missing; ${target} was left as it is`);
    }
    originalBytes = readFileSync(manifest.backup);
  }
  const original = originalBytes === null ? { hooks: {} } : parseHooksFile(originalBytes.toString('utf8'), manifest.backup);

  if (isDeepStrictEqual(normalized(stripped), normalized(original))) {
    // Nothing but ccmem's hooks changed since install: put back exactly what was there.
    if (originalBytes === null) {
      rmSync(target);
    } else {
      writeOwnedFile(target, originalBytes);
    }
    removeManifest(dataRoot, 'codex');
    return { changed: true, restored: true };
  }

  if (!removedAny) {
    // The human already took ccmem's hooks out and changed other things; leave their file alone.
    removeManifest(dataRoot, 'codex');
    return { changed: false, restored: false };
  }

  // The human edited the file after install: keep their edits, remove only ccmem's hooks.
  const backup = backupFile(target);
  writeOwnedFile(target, serialize(stripped));
  removeManifest(dataRoot, 'codex');
  return {
    changed: true,
    restored: false,
    removed: manifest.entries.length - missing.length,
    total: manifest.entries.length,
    missing,
    backup
  };
}
