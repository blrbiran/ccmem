import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

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

export function resolveProjectKey(cwd) {
  const result = spawnSync('git', ['config', '--get', 'remote.origin.url'], {
    cwd,
    encoding: 'utf8'
  });

  if (result.status === 0 && result.stdout.trim()) {
    return normalizeRemoteUrl(result.stdout.trim());
  }

  return fallbackProjectKey(cwd);
}
