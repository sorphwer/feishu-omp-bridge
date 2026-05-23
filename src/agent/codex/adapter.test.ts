import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexAdapter } from './adapter';
import type { AgentEvent } from '../types';

async function fakeCodex(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-adapter-test-'));
  const path = join(dir, 'codex-fake.mjs');
  await writeFile(path, `#!/usr/bin/env node\n${source}`, 'utf8');
  await chmod(path, 0o700);
  return path;
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('CodexAdapter', () => {
  it('reports availability from the configured binary', async () => {
    const binary = await fakeCodex(`
if (process.argv.includes('--version')) {
  console.log('codex 1.0.0');
  process.exit(0);
}
process.exit(1);
`);

    await expect(new CodexAdapter({ binary }).isAvailable()).resolves.toBe(true);
  });

  it('translates JSONL stdout from a Codex run', async () => {
    const binary = await fakeCodex(`
if (process.argv.includes('--version')) process.exit(0);
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'pong' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }));
`);

    const run = new CodexAdapter({ binary }).run({ prompt: 'ping', cwd: tmpdir() });

    await expect(collect(run.events)).resolves.toEqual([
      { type: 'system', sessionId: 'thread-1' },
      { type: 'text', delta: 'pong' },
      { type: 'usage', inputTokens: 1, outputTokens: 2 },
      { type: 'done' },
    ]);
    await expect(run.waitForExit(100)).resolves.toBe(true);
  });

  it('surfaces non-zero Codex exits after stdout closes', async () => {
    const binary = await fakeCodex(`
console.error('auth required');
process.exit(7);
`);

    const run = new CodexAdapter({ binary }).run({ prompt: 'ping', cwd: tmpdir() });

    await expect(collect(run.events)).resolves.toEqual([
      { type: 'error', message: 'codex exited with code 7: auth required' },
    ]);
  });
});
