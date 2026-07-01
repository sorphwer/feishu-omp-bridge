import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';

/**
 * Compute the **session scope** for a message.
 *
 *  - **p2p / regular group (no threads)**: scope = `chatId`.
 *  - **threaded message**: scope = `${chatId}:${threadId}`. Applies to topic
 *    groups AND regular groups with Feishu "话题"/threads enabled — Feishu
 *    reports the latter as `chat_mode:'group'` yet stamps every message with a
 *    stable `thread_id` (`omt_…`). We key off the thread id directly rather
 *    than the chat mode; gating on `chat_mode==='topic'` collapses every
 *    thread of such a group into one scope (shared session, a single active
 *    run, and cross-thread reply mis-anchoring).
 *
 * Each thread thus gets its own session / cwd / pending queue / active run.
 */
export function scopeFor(chatId: string, threadId: string | undefined): string {
  return threadId ? `${chatId}:${threadId}` : chatId;
}

/** Convenience overload from a NormalizedMessage. */
export function scopeForMessage(msg: NormalizedMessage): string {
  return scopeFor(msg.chatId, msg.threadId);
}
