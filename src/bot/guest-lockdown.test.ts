import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildProfileRunArgs, profileHookSource, profileOverlayYaml } from './guest-lockdown';

type ToolCallHandler = (event: {
  toolName: string;
  input?: Record<string, unknown>;
}) => Promise<{ block: true; reason: string } | undefined>;

/** Write the generated hook to disk, import it, and capture its tool_call handler. */
async function loadHookHandler(source: string): Promise<ToolCallHandler> {
  const dir = await mkdtemp(join(tmpdir(), 'glh-'));
  const file = join(dir, 'hook.mjs');
  await writeFile(file, source, 'utf8');
  const mod = (await import(pathToFileURL(file).href)) as {
    default: (pi: { on: (ev: string, fn: ToolCallHandler) => void }) => void;
  };
  let handler: ToolCallHandler | undefined;
  mod.default({ on: (_ev, fn) => { handler = fn; } });
  if (!handler) throw new Error('hook registered no tool_call handler');
  return handler;
}

describe('profileOverlayYaml', () => {
  it('disables discovery sources so config-sourced MCP never loads', () => {
    const yaml = profileOverlayYaml(false, false);
    expect(yaml).toContain('disabledProviders:');
    for (const src of ['native', 'claude', 'codex', 'gemini', 'github', 'opencode', 'cursor', 'agents-md']) {
      expect(yaml).toContain(`- ${src}`);
    }
    expect(yaml).toContain('discoveryMode: off');
  });

  it('disables the shared memory backend when memory is off', () => {
    const yaml = profileOverlayYaml(false, false);
    expect(yaml).toContain('memory:');
    expect(yaml).toContain('backend: "off"');
  });

  it('emits no overlay when both discovery and memory stay on', () => {
    expect(profileOverlayYaml(true, true)).toBe('');
  });

  it('emits only the section that is turned off', () => {
    const memoryOnly = profileOverlayYaml(true, false);
    expect(memoryOnly).toContain('backend: "off"');
    expect(memoryOnly).not.toContain('discoveryMode: off');

    const discoveryOnly = profileOverlayYaml(false, true);
    expect(discoveryOnly).toContain('discoveryMode: off');
    expect(discoveryOnly).not.toContain('memory:');
  });
});

describe('profileHookSource', () => {
  const noLimits = { maxTotal: 0, perTool: {} };

  it('emits a fail-closed allowlist hook embedding the allowed tool names', () => {
    const src = profileHookSource(['zendesk_kg', 'read'], noLimits);
    expect(src).toContain('const ALLOWED = new Set(["zendesk_kg","read"])');
    expect(src).toContain('pi.on("tool_call"');
    expect(src).toContain('block: true');
    expect(src).toContain('export default function hook');
  });

  it('blocks everything when the allowlist is empty', () => {
    const src = profileHookSource([], noLimits);
    expect(src).toContain('const ALLOWED = new Set([])');
    expect(src).toContain('block: true');
  });

  it('bakes per-run total and per-tool call caps', () => {
    const src = profileHookSource(['zendesk_kg'], { maxTotal: 12, perTool: { zendesk_kg: 8 } });
    expect(src).toContain('const MAX_TOTAL = 12');
    expect(src).toContain('const PER_TOOL = {"zendesk_kg":8}');
    expect(src).toContain('total > MAX_TOTAL');
    expect(src).toContain('counts[name] > cap');
  });
  describe('read path guard', () => {
    async function setupFs() {
      const base = await mkdtemp(join(tmpdir(), 'glr-'));
      const root = join(base, 'media', 'oc_chat');
      const other = join(base, 'media', 'oc_other');
      await mkdir(root, { recursive: true });
      await mkdir(other, { recursive: true });
      await writeFile(join(root, 'report.log'), 'line1\nline2\n');
      await writeFile(join(base, 'secret.txt'), 'nope');
      await writeFile(join(other, 'foreign.log'), 'nope');
      await symlink(join(base, 'secret.txt'), join(root, 'sneaky.txt'));
      return { base, root, other };
    }

    it('allows reads inside the chat media root, selectors included', async () => {
      const { root } = await setupFs();
      const handler = await loadHookHandler(profileHookSource(['read'], noLimits, [root]));
      expect(await handler({ toolName: 'read', input: { path: join(root, 'report.log') } })).toBeUndefined();
      expect(await handler({ toolName: 'read', input: { path: `${join(root, 'report.log')}:1-2` } })).toBeUndefined();
    });

    it('blocks reads outside the root: absolute, .., sibling chat, symlink escape, missing path', async () => {
      const { base, root, other } = await setupFs();
      const handler = await loadHookHandler(profileHookSource(['read'], noLimits, [root]));
      const cases = [
        { path: join(base, 'secret.txt') },
        { path: join(root, '..', '..', 'secret.txt') },
        { path: join(other, 'foreign.log') },
        { path: join(root, 'sneaky.txt') }, // symlink → outside
        { path: join(root, 'does-not-exist.log') },
        {},
      ];
      for (const input of cases) {
        const res = await handler({ toolName: 'read', input });
        expect(res?.block, JSON.stringify(input)).toBe(true);
      }
    });

    it('blocks every read when read is granted but no roots are passed', async () => {
      const { root } = await setupFs();
      const handler = await loadHookHandler(profileHookSource(['read'], noLimits));
      const res = await handler({ toolName: 'read', input: { path: join(root, 'report.log') } });
      expect(res?.block).toBe(true);
    });

    it('leaves non-read allowlisted tools untouched', async () => {
      const { root } = await setupFs();
      const handler = await loadHookHandler(profileHookSource(['read', 'zendesk_kg'], noLimits, [root]));
      expect(await handler({ toolName: 'zendesk_kg', input: { args: ['search', 'x'] } })).toBeUndefined();
    });
  });
});

describe('buildProfileRunArgs', () => {
  it('passes a plain full profile through with no run args', async () => {
    const args = await buildProfileRunArgs({
      name: 'full', restricted: false, builtinTools: [], commandTools: [],
      feishuHostTools: true, historyTools: false, historyLimit: 18, discovery: true, memory: true, maxToolCalls: 0, extensions: [],
    });
    expect(args.tools).toBeUndefined();
    expect(args.configOverlayPaths).toEqual([]);
    expect(args.extensionPaths).toEqual([]);
  });

  it('appends a full profile’s custom extension hooks (no generated artifacts)', async () => {
    const args = await buildProfileRunArgs({
      name: 'fx', restricted: false, builtinTools: [], commandTools: [],
      feishuHostTools: true, historyTools: false, historyLimit: 18, discovery: true, memory: true, maxToolCalls: 0,
      extensions: ['/abs/custom-hook.mjs'],
    });
    expect(args.tools).toBeUndefined();
    expect(args.configOverlayPaths).toEqual([]);
    expect(args.extensionPaths).toEqual(['/abs/custom-hook.mjs']);
  });

  it('puts ONLY built-in tool names in --tools; command tools ride the hook', async () => {
    const args = await buildProfileRunArgs({
      name: 'kb', restricted: true, builtinTools: ['read'],
      commandTools: [{ name: 'zendesk_kg', command: 'zendesk-kg', timeoutMs: 1000, maxOutputBytes: 1000 }],
      feishuHostTools: true, historyTools: false, historyLimit: 18, discovery: false, memory: false, maxToolCalls: 0, extensions: [],
    });
    expect(args.tools).toBe('read');
    expect(args.noBuiltins).toBe(false);
    expect(args.extensionPaths.length).toBe(1);
  });

  it('requests --no-tools when a restricted profile pins zero built-ins', async () => {
    const args = await buildProfileRunArgs({
      name: 'locked', restricted: true, builtinTools: [],
      commandTools: [{ name: 'zendesk_kg', command: 'zendesk-kg', timeoutMs: 1000, maxOutputBytes: 1000 }],
      feishuHostTools: false, historyTools: false, historyLimit: 18, discovery: false, memory: false, maxToolCalls: 0, extensions: [],
    });
    expect(args.tools).toBeUndefined();
    expect(args.noBuiltins).toBe(true);
  });
  it('allowlists + caps the history tools when historyTools is on', async () => {
    const args = await buildProfileRunArgs({
      name: 'kb', restricted: true, builtinTools: ['read'],
      commandTools: [],
      feishuHostTools: false, historyTools: true, historyLimit: 18, discovery: false, memory: false, maxToolCalls: 0, extensions: [],
    });
    const hookPath = args.extensionPaths[0]!;
    const { readFile } = await import('node:fs/promises');
    const hook = await readFile(hookPath, 'utf8');
    expect(hook).toContain('"feishu_list_recent"');
    expect(hook).toContain('"feishu_fetch_attachment"');
    expect(hook).toContain('"feishu_list_recent":3');
    expect(hook).toContain('"feishu_fetch_attachment":5');
    expect(args.tools).toBe('read'); // host tools never leak into --tools
  });
});
