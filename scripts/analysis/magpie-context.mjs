// Read-only analysis: how much prompt context ccmem occupies per agent API
// request, and how prompt caching behaves, from the files the local model
// proxy magpie already writes. Never writes anything; never touches ccmem data.
//
//   node scripts/analysis/magpie-context.mjs [requests|cache|summary] [options]
//
// Options: --magpie-dir <dir> (default ~/.config/magpie)  --since/--until <ISO date or time>
//          --agent <id>  --session <id prefix>  --model <substring>  --json  --show-text
//
// Output is numbers, ids, model/agent names and section labels only. Archived
// request bodies hold conversation text; a short excerpt is printed only with
// --show-text.
//
// magpie file formats, as read from its source (github.com/yetone/magpie @ fb1f4856a):
// - usage.jsonl: usage.Record (internal/usage/usage.go:30-237), path usage.go:277.
//   route_id :32, t :33, agent :34, provider :35, model :58, in/out :68-69,
//   cache_read/cache_write :76-77 (neither is in `in`), cache_write_1h :83,
//   cache_unknown :89, session :173, subagent :182, handed_on :196 (a failed
//   try, not the request's outcome), archive "<date>/<id>" :220.
// - routing/<local-date>.jsonl, gzipped to .jsonl.gz once the day is over
//   (internal/gateway/history.go:39,103,115-118; a late route can sit in a
//   .jsonl beside the .gz). One Route a line (internal/gateway/trace.go:48-175):
//   id :66 (seeded from UnixMilli at start, :678-684), time :67, agent :68,
//   session :70, usage []RouteUsage :73 (:179-190), model :76, provider :79,
//   sub :97, subagentId :105, prompt :163, archive :174.
//   Prompt (internal/gateway/prompt.go:44-71): tokens, counted, parts[{kind,
//   tokens, items[{name, tag, n, tokens}]}], kinds :31-39; at most 24 items a
//   part, the rest summed into "other" (:73,231-236). Claude Code's
//   <system-reminder> user texts are summed into one memory item "reminders"
//   (:467-471); a file a Read tool returned is a files item named by its path
//   (:603-614).
// - request-archive/<UTC date>/<id>.json (internal/gateway/archive_local.go:5,
//   59-83), written only when settings' requestArchiveLocal is on and sync has
//   no S3 bucket (archive.go:87-101). Archived{id, call, request, response}
//   (archive.go:184-211); request.body is the client's request as a string,
//   secrets scrubbed (:289-291); call.from is its protocol (gateway.go:426,
//   values internal/provider/provider.go:40-43).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

// The strings ccmem itself puts into a prompt. Each is matched at the start of
// a line (optionally after a Read tool's line number), so ccmem's own source
// code quoting them is not counted.
export const CCMEM_MARKERS = [
  '## ccmem context', //                           SessionStart read instruction: scripts/handlers/session-start.mjs:34
  '=== ccmem: retrieved for current prompt ===', // UserPromptSubmit / context-file retrieved block: scripts/lib/render.mjs:10
  '=== ccmem: stable context ===', //              stable context (inline or in the file): scripts/lib/render.mjs:20
  '<!-- content-hash: ', //                        context file header: scripts/lib/context-file.mjs:161
  '<!-- ccmem: no relevant memories -->' //        empty context file: scripts/lib/context-file.mjs:17
];
const PARTS = ['system', 'tools', 'skills', 'memory', 'files', 'results', 'chat']; // prompt.go:41
const CONTEXT_FILE = /(^|\/)\.ccmem\/context-[^/]+\.md$/; // scripts/lib/context-file.mjs:121-123

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MARKER_RE = new RegExp(`(?:^|\\n)[ \\t]*(?:\\d+[\\t→])?(${CCMEM_MARKERS.map(escapeRe).join('|')})`);

// magpie's own rough count (prompt.go:76-91): ~4 ASCII chars a token, 1 a non-ASCII rune.
export function tokensOf(s) {
  let ascii = 0;
  let other = 0;
  for (const ch of s ?? '') {
    if (ch.codePointAt(0) < 0x80) ascii += 1;
    else other += 1;
  }
  return Math.floor((ascii + 3) / 4) + other;
}

// The ccmem part of one text: from its first marker to the end of the text or
// of the <system-reminder> it sits in, whichever comes first.
export function ccmemSegment(text) {
  const m = MARKER_RE.exec(text ?? '');
  if (!m) return '';
  const start = m.index + m[0].length - m[1].length;
  const end = text.indexOf('</system-reminder>', start);
  return text.slice(start, end < 0 ? text.length : end);
}
export const hasMarker = (text) => MARKER_RE.test(text ?? '');

// ---------- reading magpie's files ----------

export function readJsonl(path) {
  let raw = readFileSync(path);
  if (path.endsWith('.gz')) raw = gunzipSync(raw);
  const out = [];
  for (const line of raw.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a half-written last line */ }
  }
  return out;
}

export function loadRoutes(dir, sinceMs = null) {
  const routes = new Map();
  const rdir = join(dir, 'routing');
  if (!existsSync(rdir)) return routes;
  const minDay = sinceMs == null ? '' : new Date(sinceMs - 86400000).toISOString().slice(0, 10);
  const files = readdirSync(rdir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f) && f.slice(0, 10) >= minDay);
  for (const f of files.sort()) {
    for (const r of readJsonl(join(rdir, f))) if (r.id != null) routes.set(r.id, r);
  }
  return routes;
}

export function loadArchive(dir, name) {
  if (!name || !/^\d{4}-\d{2}-\d{2}\/[0-9a-z-]{1,64}$/.test(name)) return null; // archive.go:171-181
  const path = join(dir, 'request-archive', `${name}.json`);
  if (!existsSync(path)) return null;
  try {
    const a = JSON.parse(readFileSync(path, 'utf8'));
    const body = JSON.parse(a.request?.body ?? '');
    return { protocol: a.call?.from ?? '', body, truncated: Boolean(a.request?.truncated) };
  } catch {
    return null; // a truncated or non-JSON body
  }
}

// ---------- a request body as ordered units ----------

// JSON without any cache_control, at any depth (Claude Code also marks blocks
// inside a tool_result).
const keyOf = (x) => JSON.stringify(x, (k, v) => (k === 'cache_control' ? undefined : v)) ?? '';
const textOfContent = (c) => (typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : keyOf(p))).join('\n')
    : keyOf(c ?? ''));
function blockText(b) {
  if (typeof b === 'string') return b;
  if (typeof b?.text === 'string') return b.text;
  if (b?.type === 'tool_result' || b?.type === 'function_call_output') return textOfContent(b.content ?? b.output);
  if (typeof b?.thinking === 'string') return b.thinking;
  return keyOf(b);
}
const unit = (loc, b) => ({ loc, key: keyOf(b), text: blockText(b), cache: JSON.stringify(b ?? '').includes('"cache_control"') });

export function guessProtocol(body) {
  if (body && 'input' in body && !('messages' in body)) return 'responses';
  if (body && ('system' in body || 'anthropic_version' in body)) return 'anthropic';
  return 'chat';
}

// Units in the order the vendor's cache prefix is built: Anthropic hashes
// tools, then system, then messages; OpenAI's prefix is the request's leading
// part (instructions/tools, then input or messages). cache_control is kept
// out of a unit's key: a moved breakpoint does not change the prefix.
export function unitsOf(protocol, body) {
  const u = [];
  const proto = protocol || guessProtocol(body);
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  if (proto === 'anthropic') {
    tools.forEach((t, i) => u.push(unit(`tools[${i}]`, t)));
    const sys = typeof body.system === 'string' ? [body.system] : body.system ?? [];
    sys.forEach((b, i) => u.push(unit(`system[${i}]`, b)));
  } else {
    if (typeof body?.instructions === 'string') u.push(unit('instructions', body.instructions));
    tools.forEach((t, i) => u.push(unit(`tools[${i}]`, t)));
  }
  const msgs = proto === 'responses' ? (typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input ?? [])
    : body?.messages ?? [];
  const label = proto === 'responses' ? 'input' : 'messages';
  msgs.forEach((m, i) => {
    if (Array.isArray(m?.content)) m.content.forEach((b, j) => u.push(unit(`${label}[${i}].content[${j}]`, b)));
    else if (m && 'content' in m && typeof m.content === 'string') {
      u.push({ ...unit(`${label}[${i}]`, m), text: m.content });
    } else u.push(unit(`${label}[${i}]`, m));
  });
  if (body?.cache_control) u.push({ loc: 'top-level cache_control', key: '', text: '', cache: true, meta: true });
  return u;
}

// Where two consecutive requests' serialized prompts stop agreeing.
export function prefixDiff(prev, next) {
  const a = prev.filter((x) => !x.meta);
  const b = next.filter((x) => !x.meta);
  const size = (xs) => xs.reduce((n, x) => n + x.key.length, 0);
  let chars = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i].key === b[i].key) { chars += a[i].key.length; continue; }
    let k = 0;
    while (k < a[i].key.length && a[i].key[k] === b[i].key[k]) k += 1;
    return {
      kind: 'changed', unit: i, at: b[i].loc, commonChars: chars + k, prevChars: size(a), nextChars: size(b),
      ccmemInDiff: hasMarker(a[i].text) || hasMarker(b[i].text),
      excerpt: { prev: a[i].key.slice(k, k + 80), next: b[i].key.slice(k, k + 80) }
    };
  }
  if (a.length <= b.length) {
    return { kind: 'append', unit: a.length, at: b[a.length]?.loc ?? null, commonChars: chars, prevChars: size(a), nextChars: size(b), ccmemInDiff: false };
  }
  return { kind: 'shrunk', unit: b.length, at: a[b.length].loc, commonChars: chars, prevChars: size(a), nextChars: size(b), ccmemInDiff: hasMarker(a[b.length].text) };
}

// ccmem's share of one archived body, scaled to the provider's count the way
// magpie calibrates its parts (prompt.go:308-343). An estimate.
export function ccmemEstimate(units, counted) {
  let total = 0;
  let mine = 0;
  for (const x of units) {
    total += tokensOf(x.text);
    mine += tokensOf(ccmemSegment(x.text));
  }
  const scale = counted > 0 && total > 0 ? counted / total : 1;
  return { marker: mine > 0, raw: mine, tokens: Math.round(mine * scale) };
}

// ---------- joining ----------

const promptTokens = (r) => (r.in ?? 0) + (r.cache_read ?? 0) + (r.cache_write ?? 0); // usage.go:70-77

function routeAttribution(route) {
  const out = { parts: null, ccmemFileTokens: 0, reminderTokens: 0 };
  if (!route?.prompt?.parts) return out;
  out.parts = {};
  for (const p of route.prompt.parts) {
    out.parts[p.kind] = p.tokens;
    for (const it of p.items ?? []) {
      if (p.kind === 'files' && CONTEXT_FILE.test(it.name ?? '')) out.ccmemFileTokens += it.tokens ?? 0;
      if (p.kind === 'memory' && it.name === 'reminders') out.reminderTokens += it.tokens ?? 0;
    }
  }
  return out;
}

export function collect(dir, f = {}) {
  const sinceMs = f.since ? Date.parse(f.since) : null;
  const untilMs = f.until ? Date.parse(f.until) : null;
  const usagePath = join(dir, 'usage.jsonl');
  const rows = existsSync(usagePath) ? readJsonl(usagePath) : [];
  const routes = loadRoutes(dir, sinceMs);
  const out = [];
  for (const r of rows) {
    if (r.handed_on || r.source === 'reported') continue;
    const t = Date.parse(r.t);
    if (sinceMs != null && t < sinceMs) continue;
    if (untilMs != null && t > untilMs) continue;
    if (f.agent && r.agent !== f.agent) continue;
    if (f.session && !(r.session ?? '').startsWith(f.session)) continue;
    if (f.model && !(r.model ?? '').includes(f.model)) continue;
    const route = r.route_id ? routes.get(r.route_id) : undefined;
    const archiveName = r.archive || route?.archive || '';
    const archived = archiveName ? loadArchive(dir, archiveName) : null;
    const prompt = promptTokens(r);
    const attr = routeAttribution(route);
    const units = archived ? unitsOf(archived.protocol, archived.body) : null;
    const est = units ? ccmemEstimate(units, prompt) : null;
    const ccmemTokens = est ? est.tokens : (attr.ccmemFileTokens || null);
    out.push({
      time: r.t, agent: r.agent, model: r.model, provider: r.provider, session: r.session ?? '',
      subagent: r.subagent || route?.subagentId || route?.sub || '', routeId: r.route_id ?? null, archive: archiveName || null,
      input: r.in ?? 0, cacheRead: r.cache_read ?? 0, cacheWrite: r.cache_write ?? 0, output: r.out ?? 0, prompt,
      hit: r.cache_unknown || prompt === 0 ? null : (r.cache_read ?? 0) / prompt,
      parts: attr.parts, routeCcmemFileTokens: attr.ccmemFileTokens, routeReminderTokens: attr.reminderTokens,
      ccmemMarker: est ? est.marker : (attr.ccmemFileTokens > 0 ? true : null),
      ccmemTokens, ccmemSource: est ? 'archive' : (attr.ccmemFileTokens > 0 ? 'route' : null),
      ccmemShare: ccmemTokens != null && prompt > 0 ? ccmemTokens / prompt : null,
      units
    });
  }
  return out.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

export function cacheBySession(reqs, showText = false) {
  const sessions = new Map();
  for (const r of reqs) {
    const key = `${r.session}\u0000${r.subagent}`;
    if (!sessions.has(key)) sessions.set(key, { session: r.session, subagent: r.subagent, requests: [] });
    sessions.get(key).requests.push(r);
  }
  return [...sessions.values()].map((s) => ({
    session: s.session, subagent: s.subagent,
    requests: s.requests.map((r, i) => {
      const prev = s.requests[i - 1];
      let diff = null;
      if (prev?.units && r.units) {
        diff = prefixDiff(prev.units, r.units);
        if (!showText) delete diff.excerpt;
      }
      return {
        time: r.time, model: r.model, input: r.input, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, hit: r.hit,
        ccmemMarker: r.ccmemMarker, breakpoints: r.units ? r.units.filter((x) => x.cache).map((x) => x.loc) : null, diff
      };
    })
  }));
}

const median = (xs) => quantile(xs, 0.5);
function quantile(xs, q) {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.floor(q * v.length))];
}
const mean = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

export function summarize(reqs) {
  const groups = new Map();
  for (const r of reqs) {
    const marker = r.ccmemMarker == null ? 'unknown' : r.ccmemMarker ? 'yes' : 'no';
    const key = [r.agent, r.model, marker].join('\u0000');
    if (!groups.has(key)) groups.set(key, { agent: r.agent, model: r.model, ccmem: marker, rows: [] });
    groups.get(key).rows.push(r);
  }
  return [...groups.values()].map(({ rows, ...g }) => ({
    ...g, n: rows.length,
    medianInput: median(rows.map((r) => r.input)), medianPrompt: median(rows.map((r) => r.prompt)), p90Prompt: quantile(rows.map((r) => r.prompt), 0.9),
    meanHit: mean(rows.map((r) => r.hit)), medianCcmemTokens: median(rows.map((r) => r.ccmemTokens)), medianCcmemShare: median(rows.map((r) => r.ccmemShare))
  })).sort((a, b) => a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model) || a.ccmem.localeCompare(b.ccmem));
}

// ---------- output ----------

const pct = (x) => (x == null ? '-' : `${(x * 100).toFixed(1)}%`);
const num = (x) => (x == null ? '-' : String(Math.round(x)));
const short = (s) => (s ? s.slice(0, 8) : '-');
const when = (t) => (t ? new Date(t).toISOString().slice(5, 19).replace('T', ' ') : '-');
function table(header, rows) {
  const w = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  return [header, ...rows].map((r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd()).join('\n');
}

function printRequests(reqs) {
  const head = ['time(UTC)', 'agent', 'model', 'session', 'in', 'c_read', 'c_write', 'out', 'hit', 'ccmem~', 'ccmem%', ...PARTS];
  return table(head, reqs.map((r) => [when(r.time), r.agent, r.model, short(r.session) + (r.subagent ? `/${short(r.subagent)}` : ''),
    r.input, r.cacheRead, r.cacheWrite, r.output, pct(r.hit), num(r.ccmemTokens), pct(r.ccmemShare),
    ...PARTS.map((p) => (r.parts ? num(r.parts[p] ?? 0) : '-'))]))
    + '\n\nccmem~ is an estimate (archive markers scaled to the provider count, else the route\'s .ccmem/context file item).';
}

function printCache(sessions, showText) {
  const out = [];
  for (const s of sessions) {
    out.push(`session ${short(s.session)}${s.subagent ? ` subagent ${short(s.subagent)}` : ''}  (${s.requests.length} requests)`);
    out.push(table(['time(UTC)', 'model', 'in', 'c_read', 'c_write', 'hit', 'ccmem', 'prefix', 'first diff', 'ccmem@diff', 'breakpoints'],
      s.requests.map((r) => [when(r.time), r.model, r.input, r.cacheRead, r.cacheWrite, pct(r.hit),
        r.ccmemMarker == null ? '?' : r.ccmemMarker ? 'yes' : 'no',
        r.diff ? `${r.diff.commonChars}/${r.diff.prevChars} (${pct(r.diff.prevChars ? r.diff.commonChars / r.diff.prevChars : null)})` : '-',
        r.diff ? `${r.diff.kind} ${r.diff.at ?? ''}`.trim() : '-', r.diff ? (r.diff.ccmemInDiff ? 'YES' : 'no') : '-',
        r.breakpoints ? r.breakpoints.join(' ') || 'none' : '-'])));
    if (showText) {
      for (const r of s.requests) {
        if (r.diff?.excerpt) out.push(`  ${when(r.time)} prev: ${JSON.stringify(r.diff.excerpt.prev)}\n  ${' '.repeat(14)} next: ${JSON.stringify(r.diff.excerpt.next)}`);
      }
    }
    out.push('');
  }
  out.push('prefix = serialized chars shared with the previous request of the same session/subagent (archived bodies only).');
  return out.join('\n');
}

function printSummary(groups) {
  return table(['agent', 'model', 'ccmem', 'n', 'med in', 'med prompt', 'p90 prompt', 'mean hit', 'med ccmem~', 'med ccmem%'],
    groups.map((g) => [g.agent, g.model, g.ccmem, g.n, num(g.medianInput), num(g.medianPrompt), num(g.p90Prompt), pct(g.meanHit),
      num(g.medianCcmemTokens), pct(g.medianCcmemShare)]))
    + '\n\nprompt = in + cache_read + cache_write; ccmem~ is an estimate.';
}

export function main(argv, write = (s) => process.stdout.write(s)) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      'magpie-dir': { type: 'string' }, since: { type: 'string' }, until: { type: 'string' }, agent: { type: 'string' },
      session: { type: 'string' }, model: { type: 'string' }, json: { type: 'boolean' }, 'show-text': { type: 'boolean' }
    }
  });
  const cmd = positionals[0] ?? 'requests';
  if (!['requests', 'cache', 'summary'].includes(cmd)) {
    process.stderr.write(`unknown subcommand ${cmd}: use requests, cache or summary\n`);
    return 2;
  }
  const dir = values['magpie-dir'] ?? join(homedir(), '.config', 'magpie');
  const reqs = collect(dir, values);
  let data;
  let text;
  if (cmd === 'requests') {
    data = reqs.map(({ units: _u, ...r }) => r);
    text = printRequests(reqs);
  } else if (cmd === 'cache') {
    data = cacheBySession(reqs, values['show-text']);
    text = printCache(data, values['show-text']);
  } else {
    data = summarize(reqs);
    text = printSummary(data);
  }
  write(values.json ? `${JSON.stringify(data, null, 2)}\n` : `${text}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
