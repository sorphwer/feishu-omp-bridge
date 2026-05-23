import type { AgentEvent } from '../types';

interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
}

interface CodexRawEvent {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: CodexUsage;
  message?: string;
  error?: string | { message?: string };
}

export function parseCodexJsonLine(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export function* translateCodexEvent(raw: unknown): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as CodexRawEvent;

  switch (evt.type) {
    case 'thread.started':
      if (evt.thread_id) yield { type: 'system', sessionId: evt.thread_id };
      return;
    case 'item.started':
      yield* translateItemStarted(evt.item);
      return;
    case 'item.completed':
      yield* translateItemCompleted(evt.item);
      return;
    case 'turn.completed':
      if (evt.usage) {
        yield {
          type: 'usage',
          inputTokens: evt.usage.input_tokens,
          outputTokens: evt.usage.output_tokens,
        };
      }
      yield { type: 'done' };
      return;
    case 'error':
      yield { type: 'error', message: errorMessage(evt) };
      return;
    default:
      return;
  }
}

function* translateItemStarted(item: CodexItem | undefined): Generator<AgentEvent> {
  if (!item?.id || !item.type) return;
  if (item.type !== 'command_execution') return;
  yield {
    type: 'tool_use',
    id: item.id,
    name: item.type,
    input: { command: item.command ?? '' },
  };
}

function* translateItemCompleted(item: CodexItem | undefined): Generator<AgentEvent> {
  if (!item?.id || !item.type) return;

  if (item.type === 'agent_message') {
    if (item.text) yield { type: 'text', delta: item.text };
    return;
  }

  if (item.type === 'command_execution') {
    yield {
      type: 'tool_result',
      id: item.id,
      output: item.aggregated_output ?? '',
      isError: typeof item.exit_code === 'number' && item.exit_code !== 0,
    };
    return;
  }

  if (item.text) {
    yield { type: 'text', delta: item.text };
  }
}

function errorMessage(evt: CodexRawEvent): string {
  if (typeof evt.message === 'string' && evt.message) return evt.message;
  if (typeof evt.error === 'string' && evt.error) return evt.error;
  if (evt.error && typeof evt.error === 'object' && evt.error.message) return evt.error.message;
  return 'codex emitted an error event';
}
