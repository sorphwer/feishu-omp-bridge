import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { CommandToolConfig } from '../config/schema';
import { buildCommandTools } from './command-tools';

function tool(cfg: Partial<CommandToolConfig> & { name: string; command: string }) {
  const [t] = buildCommandTools([cfg], tmpdir());
  if (!t) throw new Error('no tool built');
  return t;
}
function textOf(result: unknown): string {
  const r = result as { content?: Array<{ text?: string }> };
  return r.content?.map((c) => c.text ?? '').join('') ?? '';
}

describe('buildCommandTools', () => {
  it('passes argv verbatim WITHOUT a shell (no injection)', async () => {
    const echo = tool({ name: 'echo_t', command: 'echo' });
    const out = await echo.execute({ args: ['hello; whoami && id'] });
    expect(out.isError).toBeFalsy();
    const text = textOf(out.result);
    // echo prints the single literal argument; the shell metachars are NOT
    // interpreted (no second command runs).
    expect(text).toContain('hello; whoami && id');
    expect(text).not.toMatch(/uid=\d+/); // `id` never executed
  });

  it('enforces the subcommand allowlist', async () => {
    const t = tool({ name: 'sub_t', command: 'echo', allowedSubcommands: ['ok'] });
    const denied = await t.execute({ args: ['nope', 'x'] });
    expect(denied.isError).toBe(true);
    expect(textOf(denied.result)).toContain('not allowed');

    const allowed = await t.execute({ args: ['ok', 'x'] });
    expect(allowed.isError).toBeFalsy();
    expect(textOf(allowed.result)).toContain('ok x');
  });

  it('rejects a missing subcommand when an allowlist is set', async () => {
    const t = tool({ name: 'sub2', command: 'echo', allowedSubcommands: ['ok'] });
    const out = await t.execute({ args: [] });
    expect(out.isError).toBe(true);
  });

  it('rejects non-array / non-string args', async () => {
    const t = tool({ name: 'bad', command: 'echo' });
    expect((await t.execute({ args: 'oops' as never })).isError).toBe(true);
    expect((await t.execute({ args: [1, 2] as never })).isError).toBe(true);
  });

  it('prepends fixed args before model args', async () => {
    const t = tool({ name: 'fixed', command: 'echo', args: ['PREFIX'] });
    const out = await t.execute({ args: ['tail'] });
    expect(textOf(out.result)).toContain('PREFIX tail');
  });

  it('appends trailing args after model args (e.g. -o json)', async () => {
    const t = tool({ name: 'suffix', command: 'echo', appendArgs: ['-o', 'json'] });
    const out = await t.execute({ args: ['search', 'q'] });
    expect(textOf(out.result)).toContain('search q -o json');
  });

  it('marks a non-zero exit as an error', async () => {
    const t = tool({ name: 'fail', command: 'false' });
    const out = await t.execute({ args: [] });
    expect(out.isError).toBe(true);
  });

  it('surfaces a spawn failure for a missing binary', async () => {
    const t = tool({ name: 'missing', command: 'definitely-not-a-real-binary-xyz' });
    const out = await t.execute({ args: [] });
    expect(out.isError).toBe(true);
    expect(textOf(out.result)).toContain('failed to spawn');
  });

  it('truncates oversized output', async () => {
    const t = tool({
      name: 'big',
      command: 'node',
      maxOutputBytes: 1000,
    });
    const out = await t.execute({
      args: ['-e', 'process.stdout.write("x".repeat(50000))'],
    });
    expect(textOf(out.result)).toContain('output truncated');
  });
});
