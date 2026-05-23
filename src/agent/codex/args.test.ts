import { describe, expect, it } from 'vitest';
import { buildCodexArgs, buildCodexPrompt } from './args';

describe('buildCodexPrompt', () => {
  it('prepends bridge run conventions to the user prompt', () => {
    const prompt = buildCodexPrompt('hello');
    expect(prompt).toContain('# feishu-codex-bridge 运行约定');
    expect(prompt).toContain('hello');
    expect(prompt).toContain('<bridge_context>');
    expect(prompt).toContain('__codex_cb');
  });
});

describe('buildCodexArgs', () => {
  it('builds new-thread codex exec args with cwd', () => {
    const args = buildCodexArgs({ prompt: 'hello', cwd: '/repo' });
    expect(args.slice(0, 6)).toEqual(['exec', '--json', '--skip-git-repo-check', '-C', '/repo', '--dangerously-bypass-approvals-and-sandbox']);
    expect(args.at(-1)).toContain('hello');
  });

  it('builds resume args without unsupported -C', () => {
    const args = buildCodexArgs({ prompt: 'continue', cwd: '/repo', sessionId: 'thread-1' });
    expect(args.slice(0, 4)).toEqual(['exec', 'resume', '--json', '--dangerously-bypass-approvals-and-sandbox']);
    expect(args).toContain('thread-1');
    expect(args).not.toContain('-C');
  });

  it('passes model and images before the prompt', () => {
    const args = buildCodexArgs({
      prompt: 'look',
      cwd: '/repo',
      model: 'gpt-5.1',
      imagePaths: ['/tmp/a.png', '/tmp/b.jpg'],
    });
    expect(args).toContain('-m');
    expect(args).toContain('gpt-5.1');
    expect(args).toContain('--image');
    expect(args).toContain('/tmp/a.png');
    expect(args).toContain('/tmp/b.jpg');
  });

  it('does not add bypass flag outside bypassPermissions mode', () => {
    const args = buildCodexArgs({ prompt: 'safe', cwd: '/repo', permissionMode: 'default' });
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});
