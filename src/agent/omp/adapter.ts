import type { ChildProcessByStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import type { AgentAdapter, AgentEvent, AgentHostTool, AgentHostUriScheme, AgentRun, AgentRunOptions, AgentUiResponse } from '../types';
import { buildOmpArgs, buildOmpPrompt } from './args';
import type { OmpModelInfo, OmpModelRoles } from './model-catalog';
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

  /**
   * Run an `omp` subcommand that emits JSON on stdout and parse it. Resolves
   * to `undefined` on any failure (binary missing, non-zero exit, unparseable)
   * so callers fall back to a default.
   */
  private runJson(args: string[]): Promise<unknown> {
    return new Promise((resolve) => {
      const child = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      child.on('error', () => resolve(undefined));
      child.on('exit', (code) => {
        if (code !== 0) return resolve(undefined);
        try {
          resolve(JSON.parse(out));
        } catch {
          resolve(undefined);
        }
      });
    });
  }

  /**
   * Probe the OMP model catalog via `omp models --json`. Returns the full
   * provider/selector list so the `/switch` picker can present a live model
   * choice rather than a hardcoded subset. Empty on any failure.
   */
  async listModels(): Promise<OmpModelInfo[]> {
    const parsed = (await this.runJson(['models', '--json'])) as { models?: unknown } | undefined;
    const raw = parsed && Array.isArray(parsed.models) ? parsed.models : [];
    const models: OmpModelInfo[] = [];
    for (const m of raw) {
      if (!m || typeof m !== 'object') continue;
      const rec = m as Record<string, unknown>;
      const provider = typeof rec.provider === 'string' ? rec.provider : '';
      const id = typeof rec.id === 'string' ? rec.id : '';
      const selector = typeof rec.selector === 'string' ? rec.selector : '';
      if (!provider || !id || !selector) continue;
      const name = typeof rec.name === 'string' && rec.name ? rec.name : id;
      models.push({ provider, id, selector, name });
    }
    return models;
  }

  /**
   * Probe authenticated providers via `omp usage --json`. A provider counts
   * as authenticated if it appears in `reports[]` (live usage) or
   * `accountsWithoutUsage[]` (api-key accounts with no usage endpoint). The
   * `/switch` picker uses this to only offer models the user can actually
   * run. Empty on any failure — callers then fall back to offering all.
   */
  async listAuthenticatedProviders(): Promise<string[]> {
    const parsed = (await this.runJson(['usage', '--json'])) as
      | { reports?: unknown; accountsWithoutUsage?: unknown }
      | undefined;
    if (!parsed) return [];
    const providers = new Set<string>();
    const collect = (arr: unknown): void => {
      if (!Array.isArray(arr)) return;
      for (const r of arr) {
        if (r && typeof r === 'object') {
          const p = (r as Record<string, unknown>).provider;
          if (typeof p === 'string' && p) providers.add(p);
        }
      }
    };
    collect(parsed.reports);
    collect(parsed.accountsWithoutUsage);
    return [...providers];
  }

  /**
   * Probe OMP's role→model bindings via `omp config get modelRoles --json`.
   * Returns the `default` role (the model used when no `--model` is passed)
   * plus all distinct role-bound selectors, each with its `:thinking` suffix
   * stripped so it matches catalog selectors. The `/switch` picker shows the
   * default as the effective current model and lists the role models.
   * Resolves to `{ roles: [] }` on any failure.
   */
  async getModelRoles(): Promise<OmpModelRoles> {
    const parsed = (await this.runJson(['config', 'get', 'modelRoles', '--json'])) as
      | { value?: Record<string, unknown> }
      | undefined;
    const value = parsed && typeof parsed.value === 'object' ? parsed.value : undefined;
    if (!value) return { roles: [] };
    const strip = (sel: string): string => {
      const colon = sel.indexOf(':');
      return colon > 0 ? sel.slice(0, colon) : sel;
    };
    const seen = new Set<string>();
    const roles: string[] = [];
    let defaultSel: string | undefined;
    for (const [role, raw] of Object.entries(value)) {
      if (typeof raw !== 'string' || !raw) continue;
      const sel = strip(raw.trim());
      if (!sel) continue;
      if (role === 'default') defaultSel = sel;
      if (!seen.has(sel)) {
        seen.add(sel);
        roles.push(sel);
      }
    }
    return { default: defaultSel, roles };
  }

  run(opts: AgentRunOptions): AgentRun {
    const args = buildOmpArgs({
      ...opts,
      sessionDir: this.sessionDir,
      thinking: this.thinking,
      tools: opts.tools ?? this.tools,
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
      async submitPrompt(kind: 'steer' | 'follow_up', message: string, imagePaths?: string[]): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) return false;
        const images = await loadOmpImages(imagePaths);
        return writeFrame(child, {
          id: `${kind}_${Date.now()}`,
          type: kind,
          message: buildOmpPrompt(message),
          ...(images.length > 0 ? { images } : {}),
        });
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
          if (opts.hostTools && opts.hostTools.length > 0) {
            writeFrameOrThrow(child, {
              id: 'host_tools_1',
              type: 'set_host_tools',
              tools: opts.hostTools.map((tool) => tool.definition),
            });
          }
          if (opts.hostUriSchemes && opts.hostUriSchemes.length > 0) {
            writeFrameOrThrow(child, {
              id: 'host_uri_schemes_1',
              type: 'set_host_uri_schemes',
              schemes: opts.hostUriSchemes.map((scheme) => scheme.definition),
            });
          }
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


      if (isHostToolCall(parsed)) {
        yield* handleHostToolCall(child, opts.hostTools ?? [], parsed);
        continue;
      }
      if (isHostUriRequest(parsed)) {
        yield* handleHostUriRequest(child, opts.hostUriSchemes ?? [], parsed);
        continue;
      }
      if (isHostToolCancel(parsed) || isHostUriCancel(parsed)) {
        log.info('agent', 'host-cancel', { frame: JSON.stringify(parsed).slice(0, 300) });
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
interface HostToolCallFrame {
  type: 'host_tool_call';
  id: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

interface HostUriRequestFrame {
  type: 'host_uri_request';
  id: string;
  operation: 'read' | 'write';
  url: string;
  content?: string;
}

async function* handleHostToolCall(
  child: OmpChild,
  tools: readonly AgentHostTool[],
  frame: HostToolCallFrame,
): AsyncGenerator<AgentEvent> {
  yield { type: 'tool_use', id: frame.toolCallId, name: frame.toolName, input: frame.arguments };
  const tool = tools.find((candidate) => candidate.definition.name === frame.toolName);
  if (!tool) {
    const message = `unknown host tool: ${frame.toolName}`;
    writeFrame(child, { type: 'host_tool_result', id: frame.id, result: textToolResult(message), isError: true });
    yield { type: 'tool_result', id: frame.toolCallId, output: message, isError: true };
    return;
  }

  try {
    const out = await tool.execute(frame.arguments);
    writeFrame(child, { type: 'host_tool_result', id: frame.id, result: normalizeToolResult(out.result), isError: out.isError === true });
    yield { type: 'tool_result', id: frame.toolCallId, output: renderHostResult(out.result), isError: out.isError === true };
  } catch (err) {
    const message = errorText(err);
    writeFrame(child, { type: 'host_tool_result', id: frame.id, result: textToolResult(message), isError: true });
    yield { type: 'tool_result', id: frame.toolCallId, output: message, isError: true };
  }
}

async function* handleHostUriRequest(
  child: OmpChild,
  schemes: readonly AgentHostUriScheme[],
  frame: HostUriRequestFrame,
): AsyncGenerator<AgentEvent> {
  const toolId = frame.id;
  yield { type: 'tool_use', id: toolId, name: `host_uri_${frame.operation}`, input: { url: frame.url } };
  const scheme = schemeOf(frame.url);
  const handler = scheme ? schemes.find((candidate) => candidate.definition.scheme === scheme) : undefined;
  if (!handler) {
    const error = `unknown host URI scheme: ${scheme ?? frame.url}`;
    writeFrame(child, { type: 'host_uri_result', id: frame.id, isError: true, error });
    yield { type: 'tool_result', id: toolId, output: error, isError: true };
    return;
  }

  try {
    const out = await handler.handle({ operation: frame.operation, url: frame.url, content: frame.content });
    writeFrame(child, { type: 'host_uri_result', id: frame.id, ...out });
    yield { type: 'tool_result', id: toolId, output: out.error ?? out.content ?? 'ok', isError: out.isError === true };
  } catch (err) {
    const error = errorText(err);
    writeFrame(child, { type: 'host_uri_result', id: frame.id, isError: true, error });
    yield { type: 'tool_result', id: toolId, output: error, isError: true };
  }
}

function isHostToolCall(value: unknown): value is HostToolCallFrame {
  return isRecord(value) &&
    value.type === 'host_tool_call' &&
    typeof value.id === 'string' &&
    typeof value.toolCallId === 'string' &&
    typeof value.toolName === 'string' &&
    isRecord(value.arguments);
}

function isHostUriRequest(value: unknown): value is HostUriRequestFrame {
  return isRecord(value) &&
    value.type === 'host_uri_request' &&
    typeof value.id === 'string' &&
    (value.operation === 'read' || value.operation === 'write') &&
    typeof value.url === 'string' &&
    (value.content === undefined || typeof value.content === 'string');
}

function isHostToolCancel(value: unknown): boolean {
  return isRecord(value) && value.type === 'host_tool_cancel';
}

function isHostUriCancel(value: unknown): boolean {
  return isRecord(value) && value.type === 'host_uri_cancel';
}

function schemeOf(url: string): string | undefined {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  return match?.[1];
}

function normalizeToolResult(result: unknown): unknown {
  if (isRecord(result) && Array.isArray(result.content)) return result;
  return textToolResult(renderHostResult(result));
}

function textToolResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

function renderHostResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
