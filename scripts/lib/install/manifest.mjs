import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Bookkeeping shared by the agent installers (`ccmem install <agent>`).
 *
 * An installer writes a file the human owns (e.g. ~/.codex/hooks.json). What it
 * did is recorded in `<dataRoot>/installs/<agent>.json` so `uninstall` can undo
 * exactly that: delete a file ccmem created, or put back the backed-up bytes.
 *
 * Mode rules (global constraints): directories and files ccmem creates get
 * 0700 / 0600 explicitly, never from the umask; files that already exist keep
 * their mode, because they are the human's.
 */

export function manifestPath(dataRoot, agent) {
  return path.join(dataRoot, 'installs', `${agent}.json`);
}

export function readManifest(dataRoot, agent) {
  const file = manifestPath(dataRoot, agent);
  if (!existsSync(file)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`the ccmem install record ${file} is unreadable (${error.message}); fix or remove it by hand`);
  }
}

export function writeManifest(dataRoot, agent, manifest) {
  const file = manifestPath(dataRoot, agent);
  ensureDir(path.dirname(file));
  writeOwnedFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  chmodSync(file, 0o600);
}

export function removeManifest(dataRoot, agent) {
  rmSync(manifestPath(dataRoot, agent), { force: true });
}

/** Creates `dir` and any missing ancestors as 0700; existing directories are left alone. */
export function ensureDir(dir) {
  if (existsSync(dir)) {
    return;
  }

  ensureDir(path.dirname(dir));
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Copies the current bytes of `file` to `<file>.bak.<ms epoch>` (0600) and returns that path. */
export function backupFile(file, now = Date.now()) {
  const bytes = readFileSync(file);
  for (let offset = 0; offset < 1000; offset += 1) {
    const backupPath = `${file}.bak.${now + offset}`;
    try {
      writeFileSync(backupPath, bytes, { mode: 0o600, flag: 'wx' });
      chmodSync(backupPath, 0o600);
      return backupPath;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  throw new Error(`could not pick a free backup name for ${file}`);
}

/**
 * Writes `data` to `file` atomically: a temp file next to the real file, then a
 * rename onto it, so a failed write never leaves a truncated file behind. A new
 * file is created 0600; an existing one keeps its mode, and when `file` is a
 * symlink (a managed dotfile) the rename lands on its target, so the link stays.
 */
export function writeOwnedFile(file, data) {
  const exists = existsSync(file);
  const real = exists ? realpathSync(file) : file;
  const mode = exists ? statSync(real).mode & 0o7777 : 0o600;
  const tmp = path.join(path.dirname(real), `.${path.basename(real)}.ccmem-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
    chmodSync(tmp, mode);
    renameSync(tmp, real);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * Minimal line diff (longest common subsequence) for showing the human what an
 * install changed. Lines are prefixed '  ', '- ' or '+ '. Returns '' when the
 * texts are equal.
 */
export function lineDiff(beforeText, afterText) {
  if (beforeText === afterText) {
    return '';
  }

  const toLines = (text) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));
  const a = toLines(beforeText);
  const b = toLines(afterText);
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = a[i] === b[j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i += 1;
      j += 1;
    } else if (j < b.length && (i === a.length || lcs[i * width + j + 1] >= lcs[(i + 1) * width + j])) {
      out.push(`+ ${b[j]}`);
      j += 1;
    } else {
      out.push(`- ${a[i]}`);
      i += 1;
    }
  }

  return `${out.join('\n')}\n`;
}
