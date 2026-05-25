import type { ChildProcessByStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions, AgentUiResponse } from '../types';
import { buildOmpArgs, buildOmpPrompt } from './args';
import {
  isReadyFrame,
  loadOmpImages,
  parseOmpJsonLine,
  translateOmpFrame,
} from './rpc';

export interface OmpAdapterOptions {
  binary?: string;
  sessionDir?: string;
  thinking?: string;
  tools?: string;
}

type OmpChild = ChildProcessByStdio<Writable, Readable, Readable>;

export class OmpAdapter implements AgentAdapter {
  readonly id = 'omp';
  readonly displayName = 'Oh My Pi';

  private readonly binary: string;
  private readonly sessionDir: string | undefined;
  private readonly thinking: string | undefined;
  private readonly tools: string | undefined;

  constructor(opts: OmpAdapterOptions = {}) {
    this.binary = opts.binary ?? 'omp';
    this.sessionDir = opts.sessionDir;
    this.thinking = opts.thinking;
    this.tools = opts.tools;
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.binary, ['--version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    const args = buildOmpArgs({
      ...opts,
      sessionDir: this.sessionDir,
      thinking: this.thinking,
      tools: this.tools,
    });
    const child = spawn(this.binary, args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        LARK_CHANNEL: process.env.LARK_CHANNEL ?? '1',
        FEISHU_OMP_BRIDGE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as OmpChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      sessionDir: this.sessionDir,
      promptChars: opts.prompt.length,
      model: opts.model,
      thinking: this.thinking,
      tools: this.tools,
      imageCount: opts.imagePaths?.length ?? 0,
    });

    const stderrChunks: Buffer[] = [];
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let runtimeError: Error | null = null;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });

    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      events: createEventStream(child, stderrChunks, () => runtimeError, opts),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop-abort', { pid: child.pid ?? null, graceMs: stopGraceMs });
        writeFrame(child, { id: 'abort_1', type: 'abort' });
        endInput(child);
        if (await waitForExitWithin(child, Math.min(1000, stopGraceMs))) return;

        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        if (await waitForExitWithin(child, stopGraceMs)) return;

        log.warn('agent', 'stop-sigkill', {
          pid: child.pid ?? null,
          graceMs: stopGraceMs,
          reason: 'grace-period-expired',
        });
        child.kill('SIGKILL');
        await waitForExit(child);
      },
      respondToUi(requestId: string, response: AgentUiResponse): boolean {
        if (child.exitCode !== null || child.signalCode !== null) return false;
        return writeFrame(child, { type: 'extension_ui_response', id: requestId, ...response });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        return waitForExitWithin(child, timeoutMs);
      },
    };
  }
}

async function* createEventStream(
  child: OmpChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  opts: AgentRunOptions,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn omp: ${err.message}` : 'spawn returned no pid',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let terminal = false;
  let sawReady = false;
  let promptSent = false;
  try {
    for await (const line of rl) {
      const parsed = parseOmpJsonLine(line);
      if (parsed === undefined) {
        if (line.trim()) log.warn('agent', 'non-json-stdout', { line });
        continue;
      }

      if (isReadyFrame(parsed)) {
        sawReady = true;
        try {
          writeFrameOrThrow(child, { id: 'state_1', type: 'get_state' });
          const images = await loadOmpImages(opts.imagePaths);
          writeFrameOrThrow(child, {
            id: 'prompt_1',
            type: 'prompt',
            message: buildOmpPrompt(opts.prompt),
            ...(images.length > 0 ? { images } : {}),
          });
          promptSent = true;
        } catch (err) {
          yield { type: 'error', message: `failed to start omp prompt: ${errorText(err)}` };
          terminal = true;
          endInput(child);
          break;
        }
        continue;
      }


      for (const event of translateOmpFrame(parsed)) {
        yield event;
        if (event.type === 'done' || event.type === 'error') terminal = true;
      }

      if (terminal) {
        endInput(child);
        break;
      }
    }
  } finally {
    rl.close();
  }

  const exit = await waitForExit(child);
  const runtimeError = getError();
  if (exit.code !== 0 && exit.signal === null) {
    const detail = stderrChunks.length > 0 ? `: ${Buffer.concat(stderrChunks).toString('utf8').trim()}` : '';
    yield { type: 'error', message: `omp exited with code ${exit.code}${detail}` };
  } else if (runtimeError) {
    yield { type: 'error', message: `omp runtime error: ${runtimeError.message}` };
  } else if (!terminal && !sawReady) {
    yield { type: 'error', message: 'omp exited before sending ready frame' };
  } else if (!terminal && !promptSent) {
    yield { type: 'error', message: 'omp exited before prompt was accepted' };
  }
}

function writeFrameOrThrow(child: OmpChild, frame: Record<string, unknown>): void {
  if (!writeFrame(child, frame)) throw new Error('stdin is closed');
}

function writeFrame(child: OmpChild, frame: Record<string, unknown>): boolean {
  if (child.stdin.destroyed || child.stdin.writableEnded) return false;
  child.stdin.write(`${JSON.stringify(frame)}\n`);
  return true;
}

function endInput(child: OmpChild): void {
  if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
}

function waitForExit(child: OmpChild): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function waitForExitWithin(child: OmpChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
