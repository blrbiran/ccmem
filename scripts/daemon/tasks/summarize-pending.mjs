import { callClaudeP } from '../claude-p.mjs';
import { writeAudit } from '../../lib/audit.mjs';
import { dedupCheck } from '../../lib/dedup.mjs';
import { vecToBlob } from '../../lib/embedding/cosine.mjs';
import { getProvider } from '../../lib/embedding/provider.mjs';
import { cleanTranscript } from '../../lib/transcript-cleaner.mjs';
import { checkQuality } from '../../lib/quality-gate.mjs';
import { parseLlmJson } from '../../lib/llm-parse.mjs';
import { insertMemory } from '../../lib/cmd/save.mjs';
import { extractEntryText, parseTranscript } from '../../lib/transcript.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { refineContentToLimit } from '../../lib/content-refiner.mjs';

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
    excerpt: joined.length <= TRANSCRIPT_EXCERPT_MAX ? joined : joined.slice(-TRANSCRIPT_EXCERPT_MAX)
  };
}

function buildSummarizePrompt(transcript) {
  return [
    'You are a memory extraction assistant.',
    'Extract durable cross-session memories as JSON.',
    'Return an array or an object with a synthesized array.',
    'Before extracting each candidate, apply this cross-session test:',
    '  "Would a FRESH Claude Code session (no prior context) benefit from knowing this?"',
    '  - YES -> extract: user preferences, project conventions, recurring patterns, architectural decisions, tool chain choices, workflow rules',
    '  - NO  -> skip: one-time commands, debugging steps that led to a fix, test run results, version/schema numbers, commit messages, file edit sequences, build output summaries',
    'Additional DO NOT extract rules:',
    '  - Test pass/fail counts (for example "961/961 pass")',
    '  - Schema/version numbers',
    '  - Commit hashes or PR numbers',
    '  - "Fixed bug X by doing Y" unless Y reveals a durable convention',
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
  writeAudit(db, 'summarize_pending_superseded', null, {
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
    writeAudit(db, 'summarize_pending_bad_payload', null, { task_id: task.id });
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
    writeAudit(db, 'summarize_pending_skipped', null, {
      task_id: task.id,
      session_id: sessionId,
      reason: 'short_session'
    });
    return;
  }

  const transcript = readTranscriptExcerpt(transcriptPath, lastMessageSeq);
  if (!transcript.excerpt) {
    writeAudit(db, 'summarize_pending_skipped', null, {
      task_id: task.id,
      session_id: sessionId,
      reason: 'empty_transcript'
    });
    return;
  }

  const cleanerCfg = cfg.summarize?.transcript_cleaner ?? {};
  const cleanerEnabled = cleanerCfg.enabled !== false;
  const cleanedResult = cleanerEnabled
    ? cleanTranscript(transcript.excerpt, cleanerCfg)
    : {
        cleaned: transcript.excerpt,
        rules_hit: [],
        before: transcript.excerpt.length,
        after: transcript.excerpt.length
      };

  if (cleanedResult.rules_hit.length > 0) {
    writeAudit(db, 'transcript_cleaned', null, {
      session_id: sessionId,
      before_chars: cleanedResult.before,
      after_chars: cleanedResult.after,
      rules_hit: cleanedResult.rules_hit,
      stripped_pct: cleanedResult.before > 0
        ? Math.round((1 - (cleanedResult.after / cleanedResult.before)) * 100)
        : 0
    });
  }

  const minAfterClean = Number(cfg.summarize?.min_transcript_after_clean ?? 200);
  if (cleanedResult.cleaned.length < (Number.isFinite(minAfterClean) ? minAfterClean : 200)) {
    writeAudit(db, 'summarize_skipped_empty_after_clean', null, {
      session_id: sessionId,
      after_chars: cleanedResult.cleaned.length
    });
    return;
  }

  let llmOutput = null;
  if (shouldUseClaudeBridge(payload)) {
    llmOutput = await callClaudeP(buildSummarizePrompt(cleanedResult.cleaned), {
      taskType: 'summarize_pending',
      jsonSchema: SUMMARIZE_PENDING_JSON_SCHEMA,
      mockOutput: payload.llm_output
    });
  }

  if (supersedeIfNewerTaskExists(db, task.id, sessionId, lastMessageSeq)) {
    return;
  }

  if (!llmOutput) {
    writeAudit(db, 'summarize_pending_stub', null, {
      task_id: task.id,
      session_id: sessionId,
      last_message_seq: lastMessageSeq,
      project_key: ctx?.project_key ?? null,
      message_count: ctx?.message_count ?? null,
      tool_calls: ctx?.tool_calls ?? null,
      transcript_entry_count: transcript.entryCount,
      transcript_excerpt: cleanedResult.cleaned
    });
    return;
  }

  const parsedItems = parseLlmJson(llmOutput, { skipTruncate: true });
  const gateCfg = cfg.summarize?.quality_gate ?? {};
  const gateEnabled = gateCfg.enabled !== false;
  const items = [];

  for (const item of parsedItems) {
    const refinedContent = await refineContentToLimit(item.content, {
      enabled: cfg.summarize?.content_refiner?.enabled !== false,
      maxChars: Number(cfg.save?.max_chars_per_memory ?? 500),
      taskType: 'summarize_pending'
    });
    const normalizedItem = { ...item, content: refinedContent };

    if (!gateEnabled) {
      items.push(normalizedItem);
      continue;
    }

    const verdict = checkQuality(normalizedItem.content, gateCfg);
    if (!verdict.pass) {
      writeAudit(db, 'quality_gate_reject', null, {
        reason: verdict.reason,
        content_excerpt: String(normalizedItem.content ?? '').slice(0, 80)
      });
      continue;
    }

    items.push(normalizedItem);
  }

  const provider = getProvider(cfg);
  if (provider) {
    try {
      await provider.load(cfg);
    } catch {}
  }

  const insertedIds = [];
  let skippedCount = 0;

  for (const item of items) {
    let contentVec = null;
    let embeddingBlob = null;

    if (provider?.isLoaded()) {
      try {
        [contentVec] = await provider.embed([item.content], cfg);
        embeddingBlob = contentVec ? vecToBlob(contentVec) : null;
      } catch {}
    }

    const scope = item.scope === 'global' ? 'global' : 'project';
    const projectKey = scope === 'global' ? null : (ctx?.project_key ?? null);
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

    try {
      const inserted = await insertMemory(db, {
        cwd: process.cwd(),
        content: item.content,
        scope,
        type: item.type,
        source: 'auto_inferred',
        projectKey,
        tags: uniqueTags(item.tags),
        embedSync: false,
        embeddingBlob
      });
      insertedIds.push(inserted.id);
    } catch {
      skippedCount += 1;
    }
  }

  writeAudit(db, 'summarize_pending_applied', null, {
    task_id: task.id,
    session_id: sessionId,
    last_message_seq: lastMessageSeq,
    inserted_count: insertedIds.length,
    skipped_count: skippedCount,
    transcript_entry_count: transcript.entryCount,
    transcript_excerpt: cleanedResult.cleaned
  });
}
