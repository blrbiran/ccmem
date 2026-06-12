import { callClaudeP } from '../claude-p.mjs';
import { writeAudit } from '../../lib/audit.mjs';
import { dedupCheck } from '../../lib/dedup.mjs';
import { getProvider } from '../../lib/embedding/provider.mjs';
import { rebuildInjectionCache } from '../../lib/injection-cache.mjs';
import { parseLlmJson } from '../../lib/llm-parse.mjs';
import { evaluateTier1, evaluateTier2, evaluateTier3 } from '../../lib/threat-scan.mjs';
import { extractEntryText, parseTranscript } from '../../lib/transcript.mjs';
import { getSourceInitialTrust } from '../../lib/trust.mjs';
import { loadConfig } from '../../lib/config.mjs';

const TRANSCRIPT_EXCERPT_MAX = 1000;
const SUMMARIZE_PENDING_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['synthesized'],
  properties: {
    synthesized: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['content', 'type', 'scope', 'tags'],
        properties: {
          content: { type: 'string' },
          type: { enum: ['rule', 'fact', 'episode'] },
          scope: { enum: ['project', 'global'] },
          tags: {
            type: 'array',
            items: { type: 'string' }
          }
        }
      }
    }
  }
};

function logAudit(db, action, details = null) {
  db.prepare(
    `INSERT INTO audit_log (ts, action, affected_ids, details)
     VALUES (?, ?, NULL, ?)`
  ).run(Date.now(), action, details ? JSON.stringify(details) : null);
}

function readTranscriptExcerpt(transcriptPath, lastMessageSeq) {
  const entries = parseTranscript(transcriptPath).slice(0, lastMessageSeq);
  const lines = entries
    .map((entry) => {
      const text = extractEntryText(entry).trim();
      if (!text) {
        return null;
      }

      return `${entry.type ?? 'unknown'}: ${text}`;
    })
    .filter(Boolean);

  const joined = lines.join('\n');

  return {
    entryCount: entries.length,
    excerpt: joined.length <= TRANSCRIPT_EXCERPT_MAX
      ? joined
      : joined.slice(-TRANSCRIPT_EXCERPT_MAX)
  };
}

function buildSummarizePrompt(transcript) {
  return [
    'You are a memory extraction assistant.',
    'Extract durable cross-session memories as JSON.',
    'Return an array or an object with a synthesized array.',
    'Do NOT extract implementation churn, test-only results, commit info, version bumps, or one-off debugging notes.',
    '',
    transcript
  ].join('\n');
}

function hasConfiguredClaudeBridge() {
  return typeof process.env.CCMEM_CLAUDE_P_COMMAND === 'string' || typeof process.env.CCMEM_CLAUDE_P_ARGS_JSON === 'string';
}

function shouldUseClaudeBridge(payload) {
  if (typeof payload.llm_output === 'string') {
    return true;
  }

  if (hasConfiguredClaudeBridge()) {
    return true;
  }

  return process.env.CCMEM_TEST_MODE !== '1';
}

function supersedeIfNewerTaskExists(db, taskId, sessionId, lastMessageSeq) {
  const newer = db.prepare(
    `SELECT id
     FROM tasks
     WHERE type = 'summarize_pending'
       AND status IN ('queued', 'running')
       AND id <> ?
       AND json_extract(payload, '$.session_id') = ?
       AND json_extract(payload, '$.last_message_seq') > ?
     LIMIT 1`
  ).get(taskId, sessionId, lastMessageSeq);

  if (!newer) {
    return false;
  }

  db.prepare(
    `UPDATE tasks
     SET status = 'superseded', finished_at = ?
     WHERE id = ?`
  ).run(Date.now(), taskId);
  logAudit(db, 'summarize_pending_superseded', {
    task_id: taskId,
    session_id: sessionId,
    last_message_seq: lastMessageSeq,
    newer_task_id: newer.id
  });
  return true;
}

function uniqueTags(tags) {
  return [...new Set((tags ?? []).map((tag) => String(tag)))];
}

export async function runSummarizePending(db, task) {
  const payload = JSON.parse(task.payload ?? '{}');
  const sessionId = payload.session_id;
  const transcriptPath = payload.transcript_path;
  const lastMessageSeq = Number(payload.last_message_seq ?? 0);
  const now = Date.now();
  const cfg = loadConfig();

  if (!sessionId || !transcriptPath || !Number.isFinite(lastMessageSeq)) {
    logAudit(db, 'summarize_pending_bad_payload', { task_id: task.id });
    return;
  }

  db.prepare(
    `UPDATE tasks
     SET status = 'superseded', finished_at = ?
     WHERE type = 'summarize_pending'
       AND status = 'queued'
       AND id <> ?
       AND json_extract(payload, '$.session_id') = ?
       AND json_extract(payload, '$.last_message_seq') < ?`
  ).run(now, task.id, sessionId, lastMessageSeq);

  if (supersedeIfNewerTaskExists(db, task.id, sessionId, lastMessageSeq)) {
    return;
  }

  const ctx = db.prepare(
    `SELECT project_key, message_count, tool_calls
     FROM session_context
     WHERE session_id = ?`
  ).get(sessionId);

  if (ctx && ctx.message_count < 2) {
    logAudit(db, 'summarize_pending_skipped', {
      task_id: task.id,
      session_id: sessionId,
      reason: 'short_session'
    });
    return;
  }

  const transcript = readTranscriptExcerpt(transcriptPath, lastMessageSeq);
  if (!transcript.excerpt) {
    logAudit(db, 'summarize_pending_skipped', {
      task_id: task.id,
      session_id: sessionId,
      reason: 'empty_transcript'
    });
    return;
  }

  let llmOutput = null;
  if (shouldUseClaudeBridge(payload)) {
    llmOutput = await callClaudeP(buildSummarizePrompt(transcript.excerpt), {
      taskType: 'summarize_pending',
      jsonSchema: SUMMARIZE_PENDING_JSON_SCHEMA,
      mockOutput: payload.llm_output
    });
  }

  if (supersedeIfNewerTaskExists(db, task.id, sessionId, lastMessageSeq)) {
    return;
  }

  if (!llmOutput) {
    logAudit(db, 'summarize_pending_stub', {
      task_id: task.id,
      session_id: sessionId,
      last_message_seq: lastMessageSeq,
      project_key: ctx?.project_key ?? null,
      message_count: ctx?.message_count ?? null,
      tool_calls: ctx?.tool_calls ?? null,
      transcript_entry_count: transcript.entryCount,
      transcript_excerpt: transcript.excerpt
    });
    return;
  }

  const items = parseLlmJson(llmOutput);
  const provider = getProvider(cfg);
  if (provider) {
    try {
      await provider.load();
    } catch {}
  }
  const insertedIds = [];
  let skippedCount = 0;

  for (const item of items) {
    const gate = evaluateTier1(item.content);
    if (!gate.ok) {
      skippedCount += 1;
      continue;
    }

    const source = 'auto_inferred';
    let scope = item.scope === 'global' ? 'global' : 'project';
    let projectKey = scope === 'global' ? null : (ctx?.project_key ?? null);
    let memoryType = item.type;
    let trustScore = getSourceInitialTrust(source);
    let tags = uniqueTags(item.tags);
    let decayStatus = 'active';
    let quarantinedAt = null;
    const t2 = evaluateTier2(item.content, source, memoryType);
    const t3 = cfg.security.tier3.enabled ? evaluateTier3(t2, source) : { action: 'allow' };
    const timestamp = Date.now();

    if (t3.action === 'force_demote') {
      memoryType = 'episode';
      scope = 'project';
      projectKey = ctx?.project_key ?? null;
      trustScore = Math.min(trustScore, 0.6);
      tags = uniqueTags([...tags, 'dangerous_command']);
    }

    if (t3.action === 'quarantine') {
      decayStatus = 'quarantine';
      quarantinedAt = timestamp;
      trustScore = Math.min(trustScore, 0.3);
      tags = uniqueTags([...tags, 'quarantine_at_write']);
    }

    let contentVec = null;
    if (provider?.isLoaded()) {
      try {
        [contentVec] = await provider.embed([item.content]);
      } catch {}
    }

    const duplicate = dedupCheck(db, {
      content: item.content,
      scope,
      projectKey,
      contentVec
    }, cfg);
    if (duplicate.duplicate) {
      skippedCount += 1;
      continue;
    }

    const result = db.prepare(
      `INSERT INTO memories (
        scope,
        project_key,
        type,
        content,
        pinned,
        source,
        trust_score,
        tags,
        decay_status,
        quarantined_at,
        last_touched_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      scope,
      projectKey,
      memoryType,
      item.content,
      source,
      trustScore,
      JSON.stringify(tags),
      decayStatus,
      quarantinedAt,
      timestamp,
      timestamp,
      timestamp
    );

    const memId = Number(result.lastInsertRowid);
    insertedIds.push(memId);

    if (decayStatus === 'quarantine') {
      writeAudit(db, 'security_quarantine_in', memId, {
        reason: 'tier3_at_write',
        suspicion_score: t2.score,
        evidence: t2.evidence,
        source: 'heuristic',
        pattern_version: cfg.security.scan_patterns_version
      });
    }
  }

  if (insertedIds.length) {
    rebuildInjectionCache(db, ctx?.project_key ?? null);
  }

  logAudit(db, 'summarize_pending_applied', {
    task_id: task.id,
    session_id: sessionId,
    last_message_seq: lastMessageSeq,
    inserted_count: insertedIds.length,
    skipped_count: skippedCount,
    transcript_entry_count: transcript.entryCount,
    transcript_excerpt: transcript.excerpt
  });
}
