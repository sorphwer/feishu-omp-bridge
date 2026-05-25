import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { describe, expect, it } from 'vitest';
import { createFeishuHostIntegration } from './feishu-host';

function fakeChannel(sent: unknown[]): LarkChannel {
  return {
    async send(...args: unknown[]) {
      sent.push(args);
    },
  } as unknown as LarkChannel;
}

describe('createFeishuHostIntegration', () => {
  it('exposes Feishu context and send/reply host tools', async () => {
    const sent: unknown[] = [];
    const host = createFeishuHostIntegration(fakeChannel(sent), {
      scope: 'chat-1:thread-1',
      chatId: 'chat-1',
      threadId: 'thread-1',
      replyToMessageId: 'msg-1',
      cwd: '/repo',
    });

    expect(host.tools.map((tool) => tool.definition.name)).toEqual([
      'feishu_current_context',
      'feishu_send_message',
      'feishu_reply_message',
      'feishu_get_message',
    ]);
    expect(host.uriSchemes[0]?.definition.scheme).toBe('feishu');

    const context = await host.tools[0]!.execute({});
    expect(JSON.stringify(context.result)).toContain('chat-1:thread-1');

    await expect(host.tools[1]!.execute({ content: 'hello' })).resolves.toEqual({
      result: { content: [{ type: 'text', text: 'sent message to chat-1' }] },
    });
    await expect(host.tools[2]!.execute({ content: 'reply' })).resolves.toEqual({
      result: { content: [{ type: 'text', text: 'replied to msg-1' }] },
    });
    expect(sent).toEqual([
      ['chat-1', { markdown: 'hello' }, { replyInThread: true }],
      ['chat-1', { markdown: 'reply' }, { replyTo: 'msg-1', replyInThread: true }],
    ]);
  });

  it('serves current context through feishu URI scheme', async () => {
    const host = createFeishuHostIntegration(fakeChannel([]), {
      scope: 'chat-1',
      chatId: 'chat-1',
      cwd: '/repo',
    });

    await expect(host.uriSchemes[0]!.handle({ operation: 'read', url: 'feishu://current/context' })).resolves.toMatchObject({
      contentType: 'application/json',
    });
    await expect(host.uriSchemes[0]!.handle({ operation: 'write', url: 'feishu://current/context' })).resolves.toMatchObject({
      isError: true,
    });
  });
});
