import { spawn } from 'node:child_process';
import type { AgentHostTool } from '../agent/types';
import type { CommandToolConfig } from '../config/schema';
import { log } from '../core/logger';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 30_000;

/**
 * Build host tools that each spawn ONE fixed CLI with a model-supplied argv
 * array. The command is spawned with `shell: false`, so the model can never
 * inject pipes, redirection, globbing, substitution, or command chaining — it
 * can only run exactly `<command> [...fixedArgs] [...args]`. `allowedSubcommands`
 * additionally pins the first model arg to a known set.
 *
 * This is the only execution surface a sandboxed (guest) sender gets: raw
 * `bash`/`eval`/MCP are removed, and this tool is the whitelisted escape hatch
 * to a specific, vetted CLI.
 */
export function buildCommandTools(configs: CommandToolConfig[], defaultCwd: string): AgentHostTool[] {
  return configs.map((cfg) => commandTool(cfg, defaultCwd));
}

function commandTool(cfg: CommandToolConfig, defaultCwd: string): AgentHostTool {
  const fixedArgs = cfg.args ?? [];
  const appendArgs = cfg.appendArgs ?? [];
  const allowed = cfg.allowedSubcommands;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = cfg.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const cwd = cfg.cwd ?? defaultCwd;

  const subcmdNote =
    allowed && allowed.length > 0
      ? ` The first argument must be one of: ${allowed.join(', ')}.`
      : '';
  const description =
    cfg.description ??
    `Run the \`${cfg.command}\` CLI. Pass arguments as a string array (argv tokens). ` +
      `Runs WITHOUT a shell — no pipes, redirection, globbing, or command chaining.${subcmdNote}`;

  return {
    definition: {
      name: cfg.name,
      label: `Run ${cfg.command}`,
      description,
      parameters: {
        type: 'object',
        properties: {
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Command-line argument tokens passed verbatim to the CLI (argv).',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    async execute(rawArgs) {
      let userArgs: string[];
      try {
        userArgs = normalizeArgs(rawArgs?.args);
      } catch (err) {
        return { result: textResult(String(err instanceof Error ? err.message : err)), isError: true };
      }
      if (allowed && allowed.length > 0) {
        const sub = userArgs[0];
        if (sub === undefined || !allowed.includes(sub)) {
          return {
            result: textResult(
              `Subcommand "${sub ?? '(none)'}" is not allowed. Allowed: ${allowed.join(', ')}.`,
            ),
            isError: true,
          };
        }
      }
      const argv = [...fixedArgs, ...userArgs, ...appendArgs];
      log.info('commandTool', 'spawn', { name: cfg.name, command: cfg.command, argc: argv.length });
      const { text, isError } = await runCommand(cfg.command, argv, cwd, timeoutMs, maxBytes);
      return { result: textResult(text), isError };
    },
  };
}

function normalizeArgs(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('`args` must be an array of strings.');
  return value.map((v, i) => {
    if (typeof v !== 'string') throw new Error(`\`args[${i}]\` must be a string (got ${typeof v}).`);
    return v;
  });
}

function runCommand(
  command: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ text: string; isError: boolean }> {
  const { promise, resolve } = Promise.withResolvers<{ text: string; isError: boolean }>();

  let stdout = '';
  let stderr = '';
  let bytes = 0;
  let truncated = false;
  let timedOut = false;
  let settled = false;

  const child = spawn(command, argv, {
    cwd,
    shell: false,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const append = (chunk: Buffer, which: 'out' | 'err'): void => {
    if (truncated) return;
    const s = chunk.toString('utf8');
    bytes += Buffer.byteLength(s);
    if (which === 'out') stdout += s;
    else stderr += s;
    if (bytes > maxBytes) {
      truncated = true;
      child.kill('SIGKILL');
    }
  };
  child.stdout?.on('data', (b: Buffer) => append(b, 'out'));
  child.stderr?.on('data', (b: Buffer) => append(b, 'err'));

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);

  const finish = (text: string, isError: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ text, isError });
  };

  child.on('error', (err: Error) => {
    finish(`failed to spawn \`${command}\`: ${err.message}`, true);
  });

  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    const parts: string[] = [];
    if (stdout.trim()) parts.push(stdout.trimEnd());
    if (stderr.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`);
    let body = parts.join('\n\n') || '(no output)';
    if (truncated) body += `\n\n[output truncated at ${maxBytes} bytes]`;
    if (timedOut) body += `\n\n[killed: exceeded ${timeoutMs}ms timeout]`;
    const status = timedOut ? 'timeout' : signal && !truncated ? `signal ${signal}` : `exit ${code ?? '?'}`;
    const header = `$ ${command} ${argv.join(' ')}\n[${status}]`;
    const isError = timedOut || (typeof code === 'number' && code !== 0);
    finish(`${header}\n\n${body}`, isError);
  });

  return promise;
}

function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}
