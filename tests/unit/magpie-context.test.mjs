import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  CCMEM_MARKERS, tokensOf, ccmemSegment, ccmemEstimate, unitsOf, prefixDiff, collect, summarize, main
} from '../../scripts/analysis/magpie-context.mjs';

// Fixtures are hand-built from magpie's Go structs (usage.Record, gateway.Route,
// gateway.Archived); never copied from a real ~/.config/magpie.
function magpieDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'magpie-ctx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'routing'));
  return dir;
}
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const usageRow = (over) => ({ t: '2026-11-10T10:00:00Z', agent: 'claude-code', provider: 'anthropic', model: 'claude-opus-5-5',
  in: 100, out: 50, cache_read: 0, cache_write: 0, status: 200, session: 'sess-aaaa1111', ...over });
const route = (id, prompt, over = {}) => ({ id, time: '2026-11-10T10:00:00Z', agent: 'claude-code', model: 'claude-opus-5-5',
  provider: 'anthropic', order: [], tries: [], done: true, prompt, ...over });
function archive(dir, name, body, from = 'anthropic') {
  const [day, id] = name.split('/');
  mkdirSync(join(dir, 'request-archive', day), { recursive: true });
  writeFileSync(join(dir, 'request-archive', day, `${id}.json`), JSON.stringify({
    id: name, call: { route: 0, agent: 'claude-code', model: 'claude-opus-5-5', from, to: from, usage: {} },
    request: { method: 'POST', path: '/v1/messages', headers: {}, body: JSON.stringify(body) },
    response: { headers: {}, body: '' }
  }));
}

test('usage rows join their route by route_id, across a gzipped past day, and a handed-on try is not a request', (t) => {
  const dir = magpieDir(t);
  writeFileSync(join(dir, 'usage.jsonl'), jsonl([
    usageRow({ route_id: 101, handed_on: true, status: 529 }), // a failed try of route 101
    usageRow({ route_id: 101, t: '2026-11-10T10:00:05Z', in: 10, cache_read: 900, cache_write: 90 }),
    usageRow({ route_id: 102, t: '2026-11-09T23:00:00Z', in: 1000 })
  ]));
  // Route 102 is only in yesterday's .gz; route 101 in today's plain file, beside a decoy id.
  writeFileSync(join(dir, 'routing', '2026-11-09.jsonl.gz'), gzipSync(jsonl([
    route(102, { tokens: 1000, counted: true, parts: [{ kind: 'system', tokens: 400 }, { kind: 'chat', tokens: 600 }] })
  ])));
  writeFileSync(join(dir, 'routing', '2026-11-10.jsonl'), jsonl([
    route(999, { tokens: 1, parts: [{ kind: 'system', tokens: 1 }] }),
    route(101, { tokens: 1000, counted: true, parts: [
      { kind: 'system', tokens: 200 },
      { kind: 'memory', tokens: 500, items: [{ name: 'reminders', tag: 'reminder', tokens: 500 }] },
      { kind: 'files', tokens: 300, items: [{ name: '/w/proj/.ccmem/context-0123456789abcdef.md', tag: 'read', tokens: 250 },
        { name: '/w/proj/src/a.js', tag: 'read', tokens: 50 }] }
    ] })
  ]));

  const reqs = collect(dir);
  assert.equal(reqs.length, 2, 'the handed-on try is skipped');
  const [r102, r101] = reqs; // sorted by time
  assert.equal(r102.routeId, 102);
  assert.deepEqual(r102.parts, { system: 400, chat: 600 }, 'parts read from the .jsonl.gz');
  assert.equal(r101.routeId, 101);
  assert.equal(r101.parts.system, 200, 'joined to route 101, not the decoy');
  assert.equal(r101.routeCcmemFileTokens, 250, 'only the .ccmem/context-*.md file item');
  assert.equal(r101.routeReminderTokens, 500);
  assert.equal(r101.prompt, 1000);
  assert.equal(r101.hit, 0.9);
  assert.equal(r101.ccmemTokens, 250, 'no archive: the route file item stands in');
  assert.equal(r101.ccmemSource, 'route');
});

test('tokensOf follows magpie: ~4 ASCII chars a token, one a non-ASCII rune', () => {
  assert.equal(tokensOf('abcd'), 1);
  assert.equal(tokensOf('abcde'), 2);
  assert.equal(tokensOf('记忆'), 2);
  assert.equal(tokensOf(''), 0);
});

test('ccmem markers: injected text is attributed, source code quoting a marker is not', () => {
  const injected = `<system-reminder>\nUserPromptSubmit hook additional context: ${CCMEM_MARKERS[1]}\n\n[m1] fact | project x\n</system-reminder>`;
  // As a hook block: the marker starts its own line.
  const hookText = `<system-reminder>\n${CCMEM_MARKERS[1]}\n\n[m1] fact | project x\n</system-reminder>\nplease fix the bug`;
  assert.equal(ccmemSegment(hookText), `${CCMEM_MARKERS[1]}\n\n[m1] fact | project x\n`, 'stops at </system-reminder>');
  assert.equal(ccmemSegment(injected), '', 'mid-line mention is not ccmem output');
  assert.equal(ccmemSegment("  const lines = ['=== ccmem: stable context ===', ''];"), '', 'quoted in code');
  // A Read tool result of the context file: line-numbered, marker after the number.
  const readResult = '     1\t<!-- content-hash: 1a2b3c4d -->\n     2\t=== ccmem: stable context ===\n     3\t- a fact';
  assert.ok(ccmemSegment(readResult).startsWith('<!-- content-hash: 1a2b3c4d -->'));

  const units = unitsOf('anthropic', { system: 'You are an agent.', messages: [
    { role: 'user', content: [{ type: 'text', text: hookText }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: "const s = '## ccmem context';" }] }
  ] });
  const raw = tokensOf(ccmemSegment(hookText));
  const total = units.reduce((n, u) => n + tokensOf(u.text), 0);
  const est = ccmemEstimate(units, total * 2);
  assert.equal(est.marker, true);
  assert.equal(est.raw, raw, 'only the hook block counts');
  assert.equal(est.tokens, raw * 2, 'scaled to the provider count');
  assert.deepEqual(ccmemEstimate(unitsOf('anthropic', { messages: [{ role: 'user', content: 'hi' }] }), 10),
    { marker: false, raw: 0, tokens: 0 });
});

const SYSTEM = [{ type: 'text', text: 'system prompt' }];
const TOOLS = [{ name: 'Read', input_schema: {} }];
const msg = (text, cache = false) => ({ role: 'user', content: [{ type: 'text', text, ...(cache ? { cache_control: { type: 'ephemeral' } } : {}) }] });

test('prefixDiff: an appended turn with a moved breakpoint keeps the whole prefix', () => {
  const a = unitsOf('anthropic', { tools: TOOLS, system: SYSTEM, messages: [msg('turn 1', true)] });
  const b = unitsOf('anthropic', { tools: TOOLS, system: SYSTEM, messages: [msg('turn 1'), { role: 'assistant', content: 'ok' }, msg('turn 2', true)] });
  const d = prefixDiff(a, b);
  assert.equal(d.kind, 'append');
  assert.equal(d.commonChars, d.prevChars);
  assert.equal(d.at, 'messages[1]');
  assert.deepEqual(a.filter((u) => u.cache).map((u) => u.loc), ['messages[0].content[0]']);
});

test('prefixDiff: a retrieval block rewritten into an earlier turn breaks the prefix there, and says it is ccmem', () => {
  const block = (n) => `<system-reminder>\n${CCMEM_MARKERS[1]}\n\n[m${n}] fact\n</system-reminder>\nturn 1`;
  const a = unitsOf('anthropic', { tools: TOOLS, system: SYSTEM, messages: [msg(block(1)), msg('turn 2')] });
  const b = unitsOf('anthropic', { tools: TOOLS, system: SYSTEM, messages: [msg(block(2)), msg('turn 2'), msg('turn 3')] });
  const d = prefixDiff(a, b);
  assert.equal(d.kind, 'changed');
  assert.equal(d.at, 'messages[0].content[0]');
  assert.equal(d.ccmemInDiff, true);
  assert.ok(d.commonChars < d.prevChars);
  // A changed tool definition is caught before any message (Anthropic's prefix order: tools, system, messages).
  const c = unitsOf('anthropic', { tools: [{ name: 'Read', input_schema: { x: 1 } }], system: SYSTEM, messages: [msg(block(1)), msg('turn 2')] });
  assert.equal(prefixDiff(a, c).at, 'tools[0]');
  assert.equal(prefixDiff(a, c).ccmemInDiff, false);
});

test('cache subcommand reads archived bodies per session; text only with --show-text', (t) => {
  const dir = magpieDir(t);
  const secret = 'PRIVATE-PROMPT-WORDS';
  // The private words sit right after the first difference, inside the excerpt window.
  const body1 = { tools: TOOLS, system: SYSTEM, messages: [msg(`one ${secret}`, true)] };
  const body2 = { tools: TOOLS, system: SYSTEM, messages: [msg(`ONE ${secret}`), msg('two', true)] };
  archive(dir, '2026-11-10/100000-aa', body1);
  archive(dir, '2026-11-10/100001-bb', body2);
  writeFileSync(join(dir, 'usage.jsonl'), jsonl([
    usageRow({ archive: '2026-11-10/100000-aa', cache_write: 50 }),
    usageRow({ archive: '2026-11-10/100001-bb', t: '2026-11-10T10:00:30Z', cache_read: 40, cache_write: 20 }),
    usageRow({ session: 'other-session', t: '2026-11-10T10:00:10Z' })
  ]));
  let out = '';
  assert.equal(main(['cache', '--magpie-dir', dir, '--session', 'sess-', '--json'], (s) => { out += s; }), 0);
  const sessions = JSON.parse(out);
  assert.equal(sessions.length, 1, '--session filters by prefix');
  const [first, second] = sessions[0].requests;
  assert.equal(first.diff, null);
  assert.equal(second.diff.kind, 'changed');
  assert.equal(second.diff.at, 'messages[0].content[0]');
  assert.equal(second.diff.ccmemInDiff, false);
  assert.deepEqual(second.breakpoints, ['messages[1].content[0]']);
  assert.ok(!out.includes(secret), 'no body text without --show-text');

  let table = '';
  main(['cache', '--magpie-dir', dir], (s) => { table += s; });
  assert.ok(!table.includes(secret), 'table output has no body text either');
  let shown = '';
  main(['cache', '--magpie-dir', dir, '--show-text'], (s) => { shown += s; });
  assert.ok(shown.includes(`ONE ${secret}`), 'the excerpt at the first difference');
});

test('summary groups by agent x model x ccmem marker', () => {
  const r = (over) => ({ agent: 'claude-code', model: 'm1', input: 10, prompt: 1000, hit: 0.5, ccmemMarker: true, ccmemTokens: 100, ccmemShare: 0.1, ...over });
  const groups = summarize([
    r({}), r({ prompt: 3000, hit: 1, ccmemTokens: 300, ccmemShare: 0.1 }), r({ prompt: 2000, ccmemTokens: 200, ccmemShare: 0.1 }),
    r({ ccmemMarker: false, ccmemTokens: 0, ccmemShare: 0 }),
    r({ ccmemMarker: null, ccmemTokens: null, ccmemShare: null }),
    r({ model: 'm2', agent: 'codex' })
  ]);
  assert.deepEqual(groups.map((g) => [g.agent, g.model, g.ccmem, g.n]), [
    ['claude-code', 'm1', 'no', 1], ['claude-code', 'm1', 'unknown', 1], ['claude-code', 'm1', 'yes', 3], ['codex', 'm2', 'yes', 1]
  ]);
  const yes = groups[2];
  assert.equal(yes.medianPrompt, 2000);
  assert.equal(yes.p90Prompt, 3000);
  assert.equal(yes.medianCcmemTokens, 200);
  assert.ok(Math.abs(yes.meanHit - 2 / 3) < 1e-9);
  assert.equal(groups[1].medianCcmemTokens, null, 'unknown stays unknown, not 0');
});
