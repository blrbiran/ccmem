import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// A local-path origin is followed at most this many hops before falling back.
const MAX_LOCAL_HOPS = 8;

export function normalizeRemoteUrl(remote) {
  if (remote.startsWith('git@')) {
    const match = remote.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
    if (match) {
      const [, host, repo] = match;
      return `${host}/${repo}`;
    }
  }

  const url = new URL(remote);
  return `${url.hostname}${url.pathname.replace(/\.git$/, '')}`;
}

export function fallbackProjectKey(cwd) {
  return `path:${crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 16)}`;
}

function readOrigin(dir) {
  const result = spawnSync('git', ['config', '--get', 'remote.origin.url'], {
    cwd: dir,
    encoding: 'utf8'
  });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

/**
 * A remote `new URL()` cannot parse is a local path -- what `git clone /path/to/repo` leaves behind. It is
 * followed to that repository's own origin, so a local clone shares the key (and the memories) of the project
 * it was cloned from. A chain that never reaches a URL -- a path that is not a repository (git reads no origin
 * there), a repository with no remote, or more than MAX_LOCAL_HOPS hops, which is also what ends a cycle --
 * falls back to the key a directory with no remote gets. Remotes `new URL()` does parse (https, ssh://,
 * file://) and scp-style remotes are keyed exactly as before, so no existing key moves.
 */
export function resolveProjectKey(cwd) {
  let dir = cwd;
  for (let hop = 0; hop <= MAX_LOCAL_HOPS; hop += 1) {
    const remote = readOrigin(dir);
    if (remote === null) return fallbackProjectKey(cwd);
    try {
      return normalizeRemoteUrl(remote);
    } catch {
      // Not URL-shaped: a local path, followed below.
    }
    dir = path.resolve(dir, remote);
  }
  return fallbackProjectKey(cwd);
}
