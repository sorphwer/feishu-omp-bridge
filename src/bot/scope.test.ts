import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { scopeFor, scopeForMessage } from './scope';

const CHAT = 'oc_926292874a70b3cd0e33c6e681103b76';
const THREAD = 'omt_1921497f4acfdb94';

function msg(over: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    messageId: 'om_x',
    chatId: CHAT,
    chatType: 'group',
    senderId: 'ou_a',
    content: 'hi',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: 0,
    ...over,
  } as NormalizedMessage;
}

describe('scopeFor', () => {
  it('returns bare chatId when there is no thread', () => {
    expect(scopeFor(CHAT, undefined)).toBe(CHAT);
    expect(scopeFor(CHAT, '')).toBe(CHAT);
  });

  it('isolates by thread_id whenever one is present', () => {
    expect(scopeFor(CHAT, THREAD)).toBe(`${CHAT}:${THREAD}`);
  });

  it('gives different threads of the same chat distinct scopes', () => {
    // The exact bug: thread A vs thread B in a chat_mode:"group" chat must
    // NOT collapse into one scope (which folds the 2nd asker into the 1st run).
    const a = scopeFor(CHAT, 'omt_19596bf2c78e5be8');
    const b = scopeFor(CHAT, 'omt_1921497f4acfdb94');
    expect(a).not.toBe(b);
    expect(a).not.toBe(CHAT);
    expect(b).not.toBe(CHAT);
  });
});

describe('scopeForMessage', () => {
  it('threads a group message that carries a thread_id (thread-enabled normal group)', () => {
    expect(scopeForMessage(msg({ threadId: THREAD }))).toBe(`${CHAT}:${THREAD}`);
  });

  it('keeps a plain group message (no thread) on the bare chat scope', () => {
    expect(scopeForMessage(msg({ threadId: undefined }))).toBe(CHAT);
  });

  it('keeps p2p on the bare chat scope', () => {
    expect(scopeForMessage(msg({ chatType: 'p2p', threadId: undefined }))).toBe(CHAT);
  });
});
