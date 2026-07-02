import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

/**
 * Feishu reaction emoji keys used by the bridge. `Typing` (敲键盘) is the
 * "I'm replying" cue; `OneSecond` (稍等) flags a message that was accepted but
 * deferred — e.g. a group member whose mid-run message can't join the active
 * run and will be answered after it finishes, under their own profile.
 */
export const REACTION_WORKING = 'Typing';
export const REACTION_DEFERRED = 'OneSecond';

/**
 * Add an emoji reaction to a message. Used for lightweight, non-spammy
 * acknowledgements (working / deferred) — especially in groups where a real
 * reply would be noise.
 *
 * Returns the reaction id on success, undefined on any failure. Failures are
 * logged but never thrown — losing a decoration must not break the reply flow,
 * and an unsupported emoji key only loses the decoration.
 */
export async function addReaction(
  channel: LarkChannel,
  messageId: string,
  emojiType: string = REACTION_WORKING,
): Promise<string | undefined> {
  try {
    const r = (await channel.rawClient.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    })) as { data?: { reaction_id?: string } };
    const id = r?.data?.reaction_id;
    if (id) log.info('reaction', 'added', { messageId, reactionId: id, emojiType });
    return id;
  } catch (err) {
    log.warn('reaction', 'add-failed', {
      messageId,
      emojiType,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** Remove a previously-added reaction. Tolerates errors silently — best
 * effort cleanup; a leftover reaction is harmless. */
export async function removeReaction(
  channel: LarkChannel,
  messageId: string,
  reactionId: string,
): Promise<void> {
  try {
    await channel.rawClient.im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
    log.info('reaction', 'removed', { messageId, reactionId });
  } catch (err) {
    log.warn('reaction', 'remove-failed', {
      messageId,
      reactionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
