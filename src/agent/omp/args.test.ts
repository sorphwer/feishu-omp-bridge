import { describe, expect, it } from 'vitest';
import { buildOmpArgs, buildOmpPrompt } from './args';

describe('buildOmpPrompt', () => {
  it('prepends bridge run conventions to the user prompt', () => {
    const prompt = buildOmpPrompt('hello');
    expect(prompt).toContain('# feishu-omp-bridge 运行约定');
    expect(prompt).toContain('hello');
    expect(prompt).toContain('<bridge_context>');
    expect(prompt).toContain('__codex_cb');
  });
});

describe('buildOmpArgs', () => {
  it('builds rpc args for a new OMP session', () => {
    const args = buildOmpArgs({ prompt: 'hello', cwd: '/repo', sessionDir: '/sessions' });
    expect(args).toEqual(['--mode', 'rpc', '--no-title', '--session-dir', '/sessions']);
  });

  it('builds resume args using the shared session dir', () => {
    const args = buildOmpArgs({
      prompt: 'continue',
      cwd: '/repo',
      sessionId: 'session-1',
      sessionDir: '/sessions',
    });
    expect(args).toEqual([
      '--mode',
      'rpc',
      '--no-title',
      '--session-dir',
      '/sessions',
      '--resume',
      'session-1',
    ]);
  });

  it('passes model, thinking, and tool filters', () => {
    const args = buildOmpArgs({
      prompt: 'look',
      cwd: '/repo',
      model: 'gpt-5.5',
      thinking: 'xhigh',
      tools: 'read,bash,edit',
    });
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5.5');
    expect(args).toContain('--thinking');
    expect(args).toContain('xhigh');
    expect(args).toContain('--tools');
    expect(args).toContain('read,bash,edit');
  });
});
