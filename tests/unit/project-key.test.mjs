import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeRemoteUrl, fallbackProjectKey, resolveProjectKey } from '../../scripts/lib/project-key.mjs';

test('normalizeRemoteUrl converts GitHub ssh remote to host/path key', () => {
  assert.equal(normalizeRemoteUrl('git@github.com:me/repo.git'), 'github.com/me/repo');
});

test('normalizeRemoteUrl converts https remote to host/path key', () => {
  assert.equal(normalizeRemoteUrl('https://gitlab.com/acme/tool.git'), 'gitlab.com/acme/tool');
});

test('fallbackProjectKey uses path prefix for non-git directories', () => {
  assert.match(fallbackProjectKey('/tmp/demo'), /^path:/);
});

// A repository cloned from a local path (`git clone /path/to/repo`) has that path as its origin, and
// `new URL()` throws on it. Every hook and `export --scope project` crashed there (found from Orca's memory
// area, 2026-10-03). The key must instead be the key of the repository the path points at, so a local clone
// shares the memories of the project it was cloned from; a chain that never reaches a URL falls back to the
// same `path:` key a repository with no remote gets.
const root = mkdtempSync(join(tmpdir(), 'ccmem-pk-'));
test.after(() => rmSync(root, { recursive: true, force: true }));

function repo(name, origin) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q');
  if (origin !== undefined) git('remote', 'add', 'origin', origin);
  return dir;
}

test('resolveProjectKey follows an absolute local-path origin to the upstream URL', () => {
  const upstream = repo('abs-up', 'git@github.com:me/upstream.git');
  const clone = repo('abs-clone', upstream);
  assert.equal(resolveProjectKey(clone), 'github.com/me/upstream');
});

test('resolveProjectKey resolves a relative local-path origin against the repository', () => {
  repo('rel-up', 'https://gitlab.com/acme/tool.git');
  const clone = repo('rel-clone', '../rel-up');
  assert.equal(resolveProjectKey(clone), 'gitlab.com/acme/tool');
});

test('resolveProjectKey follows more than one local hop', () => {
  const a = repo('hop-a', 'https://example.com/team/a.git');
  const b = repo('hop-b', a);
  const c = repo('hop-c', b);
  assert.equal(resolveProjectKey(c), 'example.com/team/a');
});

test('resolveProjectKey falls back when two local repositories name each other as origin', () => {
  const a = repo('cyc-a', join(root, 'cyc-b'));
  repo('cyc-b', a);
  assert.equal(resolveProjectKey(a), fallbackProjectKey(a));
});

test('resolveProjectKey falls back when the local-path origin is not a repository', () => {
  const dir = repo('notrepo-clone', join(root, 'does-not-exist'));
  assert.equal(resolveProjectKey(dir), fallbackProjectKey(dir));
});

test('resolveProjectKey falls back when the local chain ends at a repository with no remote', () => {
  const end = repo('noremote-end');
  const clone = repo('noremote-clone', end);
  assert.equal(resolveProjectKey(clone), fallbackProjectKey(clone));
});

test('resolveProjectKey stops after a bounded number of local hops', () => {
  let previous = repo('deep-0', 'https://example.com/deep/root.git');
  for (let i = 1; i <= 9; i += 1) previous = repo(`deep-${i}`, previous);
  // deep-9 is nine local hops from the URL; the cap is eight.
  assert.equal(resolveProjectKey(previous), fallbackProjectKey(previous));
  // deep-8 is eight hops: still reached.
  assert.equal(resolveProjectKey(join(root, 'deep-8')), 'example.com/deep/root');
});

test('resolveProjectKey leaves a file:// origin keyed as it always was', () => {
  const dir = repo('fileurl', 'file:///srv/git/thing.git');
  assert.equal(resolveProjectKey(dir), '/srv/git/thing');
});
