import { spawn } from 'node:child_process';

/**
 * ccmem for oh-my-pi (OMP). OMP does not run Claude-style command hooks, so
 * this extension forwards three OMP events to ccmem's existing hook entry,
 * `scripts/hook.mjs <mode> --agent omp`, with the Claude-shaped stdin JSON the
 * handlers already read:
 *
 *   session_start,     -> session-start: the short read instruction is sent once
 *   session_switch        per session as a hidden next-turn message (OMP emits
 *                         session_start only at startup; /new, /resume and fork
 *                         emit session_switch with the new session in ctx)
 *   before_agent_start -> prompt-submit: rewrites the context file; returns
 *                         nothing, so OMP's system prompt is never touched
 *   session_stop       -> stop: hands the session file to ccmem's learner
 *
 * Every handler resolves, never rejects: a hook that fails or hangs is killed
 * after `timeoutMs` and treated as having said nothing, so ccmem can neither
 * crash an OMP session nor hold a turn longer than that.
 *
 * Kept to erasable TypeScript (types and interfaces only) so Node's native type
 * stripping can import it in tests; OMP loads it with Bun.
 */

// Structural slices of OMP's extension API, checked against the installed
// @oh-my-pi/pi-coding-agent 18.10.1 (src/extensibility/extensions/types.ts,
// shared-events.ts). Only what this file uses is declared.
interface OmpContext {
  cwd: string;
  mode?: string;
  agent?: { kind?: string };
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
  };
}

interface OmpBeforeAgentStartEvent {
  prompt: string;
}

interface OmpSessionStopEvent {
  session_id: string;
  session_file?: string;
  signal?: AbortSignal;
}

interface OmpExtensionApi {
  on(event: 'session_start' | 'session_switch', handler: (event: unknown, ctx: OmpContext) => Promise<undefined>): void;
  on(event: 'before_agent_start', handler: (event: OmpBeforeAgentStartEvent, ctx: OmpContext) => Promise<undefined>): void;
  on(event: 'session_stop', handler: (event: OmpSessionStopEvent, ctx: OmpContext) => Promise<undefined>): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options: { deliverAs: 'nextTurn' }
  ): void;
}

export interface CcmemExtensionOptions {
  node: string;
  hookScript: string;
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
}

type HookMode = 'session-start' | 'prompt-submit' | 'stop';

interface HookInput {
  session_id: string;
  cwd: string;
  transcript_path?: string;
  prompt?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;

export function createCcmemExtension(opts: CcmemExtensionOptions): (pi: OmpExtensionApi) => void {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnImpl = opts.spawnImpl ?? spawn;

  // Resolves with the hook's stdout, or '' on any spawn error, non-zero exit,
  // timeout or abort of `signal` (the hook is killed on the last two).
  function runHook(mode: HookMode, input: HookInput, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abandon: (() => void) | undefined;
      const finish = (stdout: string) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (abandon) {
            signal?.removeEventListener('abort', abandon);
          }
          resolve(stdout);
        }
      };

      try {
        const child = spawnImpl(
          opts.node,
          ['--no-warnings', '--experimental-sqlite', opts.hookScript, mode, '--agent', 'omp'],
          { stdio: ['pipe', 'pipe', 'ignore'] }
        );
        abandon = () => {
          child.kill('SIGKILL');
          finish('');
        };

        let stdout = '';
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.on('error', () => finish(''));
        child.on('close', (code: number | null) => finish(code === 0 ? stdout : ''));
        // A hook that exits before reading stdin makes the write fail with EPIPE.
        child.stdin?.on('error', () => {});
        child.stdin?.end(JSON.stringify(input));

        // Unref'd: an abandoned handler must not keep OMP alive at exit.
        timer = setTimeout(abandon, timeoutMs);
        timer.unref?.();
        if (signal?.aborted) {
          abandon();
        } else {
          signal?.addEventListener('abort', abandon, { once: true });
        }
      } catch {
        finish('');
      }
    });
  }

  function additionalContextOf(stdout: string): string {
    try {
      const context = JSON.parse(stdout)?.hookSpecificOutput?.additionalContext;
      return typeof context === 'string' ? context : '';
    } catch {
      return '';
    }
  }

  // Subagents share the parent's memory session; print runs (including ccmem's
  // own `omp -p` summarizer) and ccmem's internal children must not feed it.
  function skipped(ctx: OmpContext): boolean {
    return ctx.agent?.kind === 'sub' || ctx.mode === 'print' || process.env.CCMEM_INTERNAL === '1';
  }

  function sessionInput(ctx: OmpContext): HookInput {
    return {
      session_id: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      transcript_path: ctx.sessionManager.getSessionFile()
    };
  }

  return (pi: OmpExtensionApi) => {
    const instructedSessions = new Set<string>();

    const instructOnce = async (_event: unknown, ctx: OmpContext): Promise<undefined> => {
      try {
        if (skipped(ctx)) {
          return undefined;
        }
        const input = sessionInput(ctx);
        if (instructedSessions.has(input.session_id)) {
          return undefined;
        }
        const instruction = additionalContextOf(await runHook('session-start', input));
        if (instruction === '' || instructedSessions.has(input.session_id)) {
          return undefined;
        }
        instructedSessions.add(input.session_id);
        pi.sendMessage({ customType: 'ccmem', content: instruction, display: false }, { deliverAs: 'nextTurn' });
      } catch {
        // Never let ccmem break the session.
      }
      return undefined;
    };
    pi.on('session_start', instructOnce);
    pi.on('session_switch', instructOnce);

    pi.on('before_agent_start', async (event, ctx) => {
      try {
        if (!skipped(ctx)) {
          await runHook('prompt-submit', { ...sessionInput(ctx), prompt: event.prompt });
        }
      } catch {
        // Never let ccmem break the turn.
      }
      return undefined;
    });

    pi.on('session_stop', async (event, ctx) => {
      try {
        if (!skipped(ctx)) {
          await runHook('stop', { session_id: event.session_id, cwd: ctx.cwd, transcript_path: event.session_file }, event.signal);
        }
      } catch {
        // Never let ccmem block the turn from settling.
      }
      return undefined;
    });
  };
}
