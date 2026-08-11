import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { AgentHostTool, AgentHostUriScheme } from '../agent/types';
import type { MediaCache } from '../media/cache';
import { fetchQuotedContext } from './quote';

export interface FeishuHostContext {
  scope: string;
  chatId: string;
  threadId?: string;
  replyToMessageId?: string;
  cwd: string;
}

export interface FeishuHostIntegration {
  tools: AgentHostTool[];
  uriSchemes: AgentHostUriScheme[];
}

/**
 * Names of the Feishu host tools registered by {@link createFeishuHostIntegration}.
 * The guest/profile sandbox hook (guest-lockdown.ts) must allowlist these when a
 * restricted profile opts into `feishuHostTools`, otherwise the fail-closed
 * `tool_call` hook would block the very host tools we just registered.
 */
export const FEISHU_HOST_TOOL_NAMES = [
  'feishu_current_context',
  'feishu_send_message',
  'feishu_reply_message',
  'feishu_get_message',
] as const;
/**
 * Names of the scoped chat-history host tools registered by
 * {@link createChatHistoryTools}. Exposed only when the profile sets
 * `historyTools: true`; the sandbox hook must allowlist them likewise.
 */
export const CHAT_HISTORY_TOOL_NAMES = ['feishu_list_recent', 'feishu_fetch_attachment'] as const;

/**
 * Scoped pull-model history access for restricted profiles: list the last N
 * messages of the CURRENT chat only (the chat id is baked in — the model
 * cannot point these at another chat), then download a listed message's
 * attachment into this chat's media cache on demand. Requires the Feishu app
 * scope `im:message.group_msg`; without it the tools surface the API error.
 */
export function createChatHistoryTools(
  channel: LarkChannel,
  ctx: FeishuHostContext,
  media: MediaCache,
  limit: number,
): AgentHostTool[] {
  return [listRecentTool(channel, ctx, limit), fetchAttachmentTool(channel, ctx, media)];
}

const ATTACHMENT_MSG_TYPES = new Set(['file', 'image', 'media', 'audio', 'video']);

/** Best-effort one-line summary of a raw message body for the history list. */
function summarizeBody(msgType: string, raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.text === 'string') return parsed.text.slice(0, 200);
    if (typeof parsed.file_name === 'string') return `[${msgType}] ${parsed.file_name}`;
    if (typeof parsed.image_key === 'string') return '[image]';
  } catch {
    /* fall through to raw */
  }
  return `[${msgType}] ${raw.slice(0, 200)}`;
}

function listRecentTool(channel: LarkChannel, ctx: FeishuHostContext, limit: number): AgentHostTool {
  return {
    definition: {
      name: 'feishu_list_recent',
      label: 'List recent chat messages',
      description:
        `List the most recent messages (up to ${limit}) of the CURRENT Feishu chat, oldest first. ` +
        'Each item has message_id, type, created_at, sender_open_id, summary, and has_attachment. '
        + 'Use feishu_fetch_attachment with a message_id to download an attachment for reading.',
      parameters: objectSchema({}),
    },
    async execute() {
      try {
        const r = (await channel.rawClient.im.v1.message.list({
          params: {
            container_id_type: 'chat',
            container_id: ctx.chatId,
            sort_type: 'ByCreateTimeDesc',
            page_size: limit,
          },
        })) as { data?: { items?: Array<Record<string, unknown>> } };
        const items = (r?.data?.items ?? []).slice(0, limit).reverse();
        const mapped = items.map((it) => {
          const msgType = typeof it.msg_type === 'string' ? it.msg_type : 'unknown';
          const body = it.body as { content?: string } | undefined;
          const createMs = Number.parseInt(String(it.create_time ?? ''), 10);
          return {
            message_id: it.message_id,
            type: msgType,
            created_at: Number.isFinite(createMs) && createMs > 0 ? new Date(createMs).toISOString() : '',
            sender_open_id: (it.sender as { id?: string } | undefined)?.id ?? '',
            summary: summarizeBody(msgType, body?.content ?? ''),
            has_attachment: ATTACHMENT_MSG_TYPES.has(msgType),
          };
        });
        return { result: jsonResult(mapped) };
      } catch (err) {
        return { result: textResult(`feishu_list_recent failed: ${describeApiError(err)}`), isError: true };
      }
    },
  };
}

function fetchAttachmentTool(channel: LarkChannel, ctx: FeishuHostContext, media: MediaCache): AgentHostTool {
  return {
    definition: {
      name: 'feishu_fetch_attachment',
      label: 'Fetch chat attachment',
      description:
        'Download the attachment(s) of a message in the CURRENT chat into the local media cache ' +
        'and return the local file path(s) for the read tool. Only works for messages of this chat.',
      parameters: objectSchema({
        messageId: { type: 'string', description: 'message_id (from feishu_list_recent or a quote) whose attachment to download.' },
      }, ['messageId']),
    },
    async execute(args) {
      const messageId = requiredString(args, 'messageId');
      try {
        const message = await fetchQuotedContext(channel, messageId);
        if (!message) {
          return { result: textResult(`message not found or inaccessible: ${messageId}`), isError: true };
        }
        // Fail closed: an empty chatId (API omitted it) is refused too — never
        // allow a cross-chat (or unverifiable) download.
        if (message.chatId !== ctx.chatId) {
          return { result: textResult('refused: that message does not verifiably belong to this chat.'), isError: true };
        }
        if (message.resources.length === 0) {
          return { result: textResult(`message ${messageId} (type ${message.rawContentType}) carries no attachment.`), isError: true };
        }
        const attachments = await media.resolve(
          ctx.chatId,
          message.resources.map((resource) => ({ messageId, resource })),
        );
        if (attachments.length === 0) {
          return { result: textResult('attachment download failed (see bridge logs).'), isError: true };
        }
        return {
          result: jsonResult(attachments.map((a) => ({ path: a.path, kind: a.kind, name: a.originalName ?? null }))),
        };
      } catch (err) {
        return { result: textResult(`feishu_fetch_attachment failed: ${describeApiError(err)}`), isError: true };
      }
    },
  };
}

/** Flatten a Feishu SDK error into its API message when available. */
function describeApiError(err: unknown): string {
  const resp = (err as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
  if (resp?.msg) return `${resp.msg}${resp.code ? ` (code ${resp.code})` : ''}`;
  return err instanceof Error ? err.message : String(err);
}

export function createFeishuHostIntegration(
  channel: LarkChannel,
  ctx: FeishuHostContext,
): FeishuHostIntegration {
  return {
    tools: [
      currentContextTool(ctx),
      sendMessageTool(channel, ctx),
      replyMessageTool(channel, ctx),
      getMessageTool(channel),
    ],
    uriSchemes: [feishuUriScheme(channel, ctx)],
  };
}

function currentContextTool(ctx: FeishuHostContext): AgentHostTool {
  return {
    definition: {
      name: 'feishu_current_context',
      label: 'Feishu current context',
      description: 'Return the current Feishu chat/topic context for this bridge run.',
      parameters: objectSchema({}),
    },
    async execute() {
      return { result: jsonResult(ctx) };
    },
  };
}

function sendMessageTool(channel: LarkChannel, ctx: FeishuHostContext): AgentHostTool {
  return {
    definition: {
      name: 'feishu_send_message',
      label: 'Send Feishu message',
      description: 'Send a markdown message to the current Feishu chat or a specified chat_id.',
      parameters: objectSchema({
        content: { type: 'string', description: 'Markdown content to send.' },
        chatId: { type: 'string', description: 'Optional target chat_id. Defaults to the current chat.' },
      }, ['content']),
    },
    async execute(args) {
      const content = requiredString(args, 'content');
      const chatId = optionalString(args, 'chatId') ?? ctx.chatId;
      await channel.send(chatId, { markdown: content }, ctx.threadId && chatId === ctx.chatId ? { replyInThread: true } : undefined);
      return { result: textResult(`sent message to ${chatId}`) };
    },
  };
}

function replyMessageTool(channel: LarkChannel, ctx: FeishuHostContext): AgentHostTool {
  return {
    definition: {
      name: 'feishu_reply_message',
      label: 'Reply in Feishu',
      description: 'Reply with markdown to the triggering Feishu message or to a specified message_id.',
      parameters: objectSchema({
        content: { type: 'string', description: 'Markdown reply content.' },
        messageId: { type: 'string', description: 'Optional message_id to reply to. Defaults to the triggering message.' },
      }, ['content']),
    },
    async execute(args) {
      const content = requiredString(args, 'content');
      const messageId = optionalString(args, 'messageId') ?? ctx.replyToMessageId;
      if (!messageId) throw new Error('messageId is required when no triggering message is available');
      await channel.send(ctx.chatId, { markdown: content }, {
        replyTo: messageId,
        ...(ctx.threadId ? { replyInThread: true } : {}),
      });
      return { result: textResult(`replied to ${messageId}`) };
    },
  };
}

function getMessageTool(channel: LarkChannel): AgentHostTool {
  return {
    definition: {
      name: 'feishu_get_message',
      label: 'Get Feishu message',
      description: 'Fetch and normalize a Feishu message by message_id. Useful for quoted messages, cards, and forwarded messages.',
      parameters: objectSchema({
        messageId: { type: 'string', description: 'Feishu/Lark message_id to fetch.' },
      }, ['messageId']),
    },
    async execute(args) {
      const messageId = requiredString(args, 'messageId');
      const message = await fetchQuotedContext(channel, messageId);
      if (!message) return { result: textResult(`message not found or inaccessible: ${messageId}`), isError: true };
      return { result: jsonResult(message) };
    },
  };
}

function feishuUriScheme(channel: LarkChannel, ctx: FeishuHostContext): AgentHostUriScheme {
  return {
    definition: {
      scheme: 'feishu',
      description: 'Read Feishu resources exposed by feishu-omp-bridge, e.g. feishu://message/<message_id> or feishu://current/context.',
      writable: false,
      immutable: false,
    },
    async handle(req) {
      if (req.operation !== 'read') {
        return { isError: true, error: 'feishu:// is read-only in this bridge', contentType: 'text/plain' };
      }
      const parsed = parseFeishuUri(req.url);
      if (parsed.kind === 'message') {
        const message = await fetchQuotedContext(channel, parsed.id);
        if (!message) return { isError: true, error: `message not found or inaccessible: ${parsed.id}`, contentType: 'text/plain' };
        return { content: JSON.stringify(message, null, 2), contentType: 'application/json' };
      }
      if (parsed.kind === 'context') {
        return { content: JSON.stringify(ctx, null, 2), contentType: 'application/json' };
      }
      return {
        isError: true,
        error: `unsupported feishu URI: ${req.url}. Supported: feishu://message/<message_id>, feishu://current/context`,
        contentType: 'text/plain',
      };
    },
  };
}

function parseFeishuUri(url: string): { kind: 'message'; id: string } | { kind: 'context' } | { kind: 'unknown' } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'unknown' };
  }
  const host = parsed.hostname;
  const path = parsed.pathname.split('/').filter(Boolean);
  if (host === 'message' && path[0]) return { kind: 'message', id: decodeURIComponent(path[0]) };
  if (host === 'current' && path[0] === 'context') return { kind: 'context' };
  return { kind: 'unknown' };
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key} is required`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

function jsonResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return textResult(JSON.stringify(value, null, 2));
}
