import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { AgentEvent } from '../types';

interface OmpModel {
  provider?: string;
  id?: string;
  name?: string;
}

interface OmpUsage {
  input?: number;
  output?: number;
  inputTokens?: number;
  outputTokens?: number;
  cost?: { total?: number };
}

interface OmpMessage {
  usage?: OmpUsage;
}

interface OmpState {
  sessionId?: string;
  model?: OmpModel;
}

interface OmpAssistantEvent {
  type?: string;
  delta?: string;
  toolCall?: unknown;
}

interface OmpFrame {
  id?: string;
  type?: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: OmpState;
  assistantMessageEvent?: OmpAssistantEvent;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  message?: OmpMessage;
  method?: string;
}

export interface OmpImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export function parseOmpJsonLine(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export function isReadyFrame(raw: unknown): boolean {
  return isRecord(raw) && raw.type === 'ready';
}

export function extensionUiAutoResponse(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw) || raw.type !== 'extension_ui_request' || typeof raw.id !== 'string') {
    return undefined;
  }

  switch (raw.method) {
    case 'select':
    case 'confirm':
    case 'input':
    case 'editor':
      return { type: 'extension_ui_response', id: raw.id, cancelled: true };
    default:
      return undefined;
  }
}

export function* translateOmpFrame(raw: unknown): Generator<AgentEvent> {
  if (!isRecord(raw)) return;
  const frame = raw as OmpFrame;

  switch (frame.type) {
    case 'response':
      yield* translateResponse(frame);
      return;
    case 'message_update':
      yield* translateMessageUpdate(frame.assistantMessageEvent);
      return;
    case 'tool_execution_start':
      if (frame.toolCallId && frame.toolName) {
        yield {
          type: 'tool_use',
          id: frame.toolCallId,
          name: frame.toolName,
          input: frame.args ?? {},
        };
      }
      return;
    case 'tool_execution_end':
      if (frame.toolCallId) {
        yield {
          type: 'tool_result',
          id: frame.toolCallId,
          output: renderToolResult(frame.result),
          isError: frame.isError === true,
        };
      }
      return;
    case 'turn_end':
      if (frame.message?.usage) {
        yield usageEvent(frame.message.usage);
      }
      return;
    case 'agent_end':
      yield { type: 'done' };
      return;
    case 'notice':
      if (typeof frame.error === 'string') yield { type: 'error', message: frame.error };
      return;
    default:
      return;
  }
}

export async function loadOmpImages(imagePaths: readonly string[] | undefined): Promise<OmpImageContent[]> {
  if (!imagePaths || imagePaths.length === 0) return [];
  const images: OmpImageContent[] = [];
  for (const imagePath of imagePaths) {
    const data = await readFile(imagePath);
    images.push({
      type: 'image',
      data: data.toString('base64'),
      mimeType: mimeTypeForPath(imagePath),
    });
  }
  return images;
}

function* translateResponse(frame: OmpFrame): Generator<AgentEvent> {
  if (frame.success === false) {
    yield { type: 'error', message: frame.error || `omp ${frame.command ?? 'command'} failed` };
    return;
  }

  if (frame.command !== 'get_state' || frame.success !== true || !frame.data) return;

  const sessionId = typeof frame.data.sessionId === 'string' ? frame.data.sessionId : undefined;
  const model = formatModel(frame.data.model);
  if (sessionId || model) yield { type: 'system', sessionId, model };
}

function* translateMessageUpdate(evt: OmpAssistantEvent | undefined): Generator<AgentEvent> {
  if (!evt) return;
  if (evt.type === 'text_delta' && typeof evt.delta === 'string') {
    yield { type: 'text', delta: evt.delta };
    return;
  }
  if (evt.type === 'thinking_delta' && typeof evt.delta === 'string') {
    yield { type: 'thinking', delta: evt.delta };
  }
}

function usageEvent(usage: OmpUsage): AgentEvent {
  return {
    type: 'usage',
    inputTokens: typeof usage.input === 'number' ? usage.input : usage.inputTokens,
    outputTokens: typeof usage.output === 'number' ? usage.output : usage.outputTokens,
    costUsd: usage.cost?.total,
  };
}

function renderToolResult(result: unknown): string {
  if (!isRecord(result)) return result === undefined ? '' : String(result);
  const content = result.content;
  if (!Array.isArray(content)) return stableStringify(result);
  return content.map(renderContentBlock).filter(Boolean).join('\n');
}

function renderContentBlock(block: unknown): string {
  if (typeof block === 'string') return block;
  if (!isRecord(block)) return stableStringify(block);
  if (block.type === 'text' && typeof block.text === 'string') return block.text;
  if (block.type === 'image') return '[image]';
  return stableStringify(block);
}

function formatModel(model: OmpModel | undefined): string | undefined {
  if (!model) return undefined;
  const id = model.id || model.name;
  if (!id) return undefined;
  return model.provider ? `${model.provider}/${id}` : id;
}

function mimeTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.png':
    default:
      return 'image/png';
  }
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
