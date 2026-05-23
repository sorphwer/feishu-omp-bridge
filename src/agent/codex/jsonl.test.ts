import { describe, expect, it } from 'vitest';
import { parseCodexJsonLine, translateCodexEvent } from './jsonl';

function events(raw: unknown) {
  return [...translateCodexEvent(raw)];
}

describe('parseCodexJsonLine', () => {
  it('parses valid JSON lines', () => {
    expect(parseCodexJsonLine('{"type":"turn.started"}')).toEqual({ type: 'turn.started' });
  });

  it('returns undefined for non-JSON lines', () => {
    expect(parseCodexJsonLine('Reading additional input from stdin...')).toBeUndefined();
  });
});

describe('translateCodexEvent', () => {
  it('maps thread.started to a system session event', () => {
    expect(events({ type: 'thread.started', thread_id: 'thread-1' })).toEqual([
      { type: 'system', sessionId: 'thread-1' },
    ]);
  });

  it('maps agent messages to text deltas', () => {
    expect(events({ type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text: 'hello' } })).toEqual([
      { type: 'text', delta: 'hello' },
    ]);
  });

  it('maps command execution start and completion to tool events', () => {
    expect(events({
      type: 'item.started',
      item: { id: 'item-1', type: 'command_execution', command: '/bin/zsh -lc pwd' },
    })).toEqual([
      {
        type: 'tool_use',
        id: 'item-1',
        name: 'command_execution',
        input: { command: '/bin/zsh -lc pwd' },
      },
    ]);

    expect(events({
      type: 'item.completed',
      item: {
        id: 'item-1',
        type: 'command_execution',
        command: '/bin/zsh -lc pwd',
        aggregated_output: '/tmp\n',
        exit_code: 0,
      },
    })).toEqual([
      { type: 'tool_result', id: 'item-1', output: '/tmp\n', isError: false },
    ]);
  });

  it('marks non-zero command exit as tool error', () => {
    expect(events({
      type: 'item.completed',
      item: {
        id: 'item-1',
        type: 'command_execution',
        aggregated_output: 'boom\n',
        exit_code: 2,
      },
    })).toEqual([
      { type: 'tool_result', id: 'item-1', output: 'boom\n', isError: true },
    ]);
  });

  it('maps turn.completed to usage and done', () => {
    expect(events({
      type: 'turn.completed',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
      },
    })).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 5 },
      { type: 'done' },
    ]);
  });

  it('maps explicit error events to errors', () => {
    expect(events({ type: 'error', message: 'bad' })).toEqual([
      { type: 'error', message: 'bad' },
    ]);
  });
});
