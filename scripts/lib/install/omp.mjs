import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
 * `ccmem install|uninstall omp`: writes `<agentDir>/extensions/ccmem.ts`, a
 * three-line loader for integrations/omp/ccmem-extension.ts, and removes it
 * again. OMP auto-discovers every `*.ts` / `*.js` directly in the agent
 * directory's `extensions/` (docs/extension-loading.md, "Auto-discovered native
 * extension modules"), so no OMP config file is edited.
 *
 * A different ccmem.ts already there is backed up, replaced, and put back on
 * uninstall. Backups are named `ccmem.ts.bak.<ms>`, which OMP's `*.{ts,js}`
 * scan does not pick up.
 */

const AGENT = 'omp';

// The loader embeds the paths in single-quoted string literals; refuse what
// would end or escape the literal rather than write a loader that fails to load.
const LITERAL_UNSAFE = /['\\\r\n]/;

export function getOmpAgentDir() {
  return process.env.CCMEM_OMP_AGENT_DIR ?? path.join(os.homedir(), '.omp', 'agent');
}

export function ompLoaderSource({ repoRoot, execPath }) {
  return [
    '// Written by `ccmem install omp`; `ccmem uninstall omp` removes it.',
    `import { createCcmemExtension } from '${repoRoot}/integrations/omp/ccmem-extension.ts';`,
    `export default createCcmemExtension({ node: '${execPath}', hookScript: '${repoRoot}/scripts/hook.mjs' });`,
    ''
  ].join('\n');
}

function loaderPath(agentDir) {
  return path.join(agentDir, 'extensions', 'ccmem.ts');
}

// `writeFile` is a seam for the failure tests; callers leave it at the default.
export function installOmp({ agentDir, dataRoot, repoRoot, execPath, writeFile = writeOwnedFile }) {
  for (const value of [execPath, repoRoot]) {
    if (LITERAL_UNSAFE.test(value)) {
      throw new Error(`refusing to install: ${JSON.stringify(value)} contains a quote, backslash or line break`);
    }
  }

  const target = loaderPath(agentDir);
  const content = ompLoaderSource({ repoRoot, execPath });
  const before = existsSync(target) ? readFileSync(target, 'utf8') : null;
  const manifest = readManifest(dataRoot, AGENT);

  if (manifest) {
    if (manifest.target === target && manifest.content === content && before === content) {
      return { changed: false, diff: '', backup: null };
    }

    throw new Error(
      `a ccmem install recorded in ${manifestPath(dataRoot, AGENT)} does not match what would be written now ` +
      `(moved repo, another node, or ${target} edited or removed); run \`ccmem uninstall omp\` first`
    );
  }

  if (before === content) {
    throw new Error(`${target} is ccmem's loader but there is no install record for it; remove it by hand, then re-run`);
  }

  ensureDir(path.dirname(target));
  const backup = before === null ? null : backupFile(target);
  const backupNote = backup ? `; its previous bytes are backed up at ${backup}` : '';
  // The manifest goes down before the loader: if writing the loader fails,
  // uninstall still knows about the backup and restores it.
  try {
    writeManifest(dataRoot, AGENT, {
      target,
      createdFile: before === null,
      backup,
      content,
      installedAt: Date.now()
    });
  } catch (error) {
    throw new Error(`could not record the install (${error.message}); ${target} was not changed${backupNote}`);
  }
  try {
    writeFile(target, content);
  } catch (error) {
    throw new Error(
      `writing ${target} failed (${error.message})${backupNote}; the install is recorded in ` +
      `${manifestPath(dataRoot, AGENT)}: run \`ccmem uninstall omp\` to restore`
    );
  }

  return { changed: true, diff: lineDiff(before ?? '', content), backup };
}

export function uninstallOmp({ agentDir, dataRoot }) {
  const manifest = readManifest(dataRoot, AGENT);
  if (!manifest) {
    return { changed: false, restored: false };
  }

  const target = loaderPath(agentDir);
  if (manifest.target !== target) {
    throw new Error(`the ccmem install record is for ${manifest.target}, not ${target}; set CCMEM_OMP_AGENT_DIR to match`);
  }

  if (!manifest.createdFile && !existsSync(manifest.backup)) {
    throw new Error(`the backup ${manifest.backup} is missing; ${target} was left as it is`);
  }

  if (!existsSync(target)) {
    if (manifest.createdFile) {
      removeManifest(dataRoot, AGENT);
      return { changed: false, restored: false };
    }
    writeOwnedFile(target, readFileSync(manifest.backup));
    removeManifest(dataRoot, AGENT);
    return { changed: true, restored: true };
  }

  // Anything other than ccmem's loader (a hand edit, or the remains of a failed
  // write) is kept next to the file before the original comes back.
  const result = { changed: true, restored: true };
  if (readFileSync(target, 'utf8') !== manifest.content) {
    result.editedBackup = backupFile(target);
  }

  if (manifest.createdFile) {
    rmSync(target);
  } else {
    writeOwnedFile(target, readFileSync(manifest.backup));
  }
  removeManifest(dataRoot, AGENT);
  return result;
}
