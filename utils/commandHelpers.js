// utils/commandHelpers.js
import { reply } from 'node:console'; // keep eslint happy if needed, not used
export function isInteraction(obj) {
  return !!(
    obj &&
    typeof obj === 'object' &&
    obj.options &&
    (typeof obj.options.get === 'function' ||
      typeof obj.options.getUser === 'function' ||
      typeof obj.options.getString === 'function' ||
      typeof obj.options.getInteger === 'function')
  );
}

/**
 * replySafe:
 * - for interactions: if not yet replied -> reply()
 *                        if deferred -> editReply()
 *                        if already replied -> followUp()
 * - for messages: fallback to message.reply()
 * - catches Unknown Interaction (10062) and sends to channel or DM instead
 *
 * opts: { embeds, ephemeral }
 */
export async function replySafe(interactionOrMessage, content, opts = {}) {
  // build payload
  const payload = {};
  if (opts.embeds) payload.embeds = opts.embeds;
  if (typeof content === 'string' && content.length) payload.content = content;
  if (opts.ephemeral) payload.ephemeral = true;

  // Interaction path
  if (isInteraction(interactionOrMessage)) {
    try {
      // if nothing to send, keep a blank content (discord forbids empty payload)
      if (Object.keys(payload).length === 0) payload.content = '\u200B';

      // if deferred -> editReply
      if (interactionOrMessage.deferred) {
        return await interactionOrMessage.editReply(payload);
      }

      // if already replied -> followUp
      if (interactionOrMessage.replied) {
        return await interactionOrMessage.followUp(payload);
      }

      // else -> reply
      return await interactionOrMessage.reply(payload);
    } catch (err) {
      // handle Unknown interaction (10062) and other problems gracefully
      try {
        const code = err?.code ?? err?.rawError?.code;
        if (code === 10062) {
          // interaction unknown/expired — fallback: send to channel if available, otherwise attempt DM
          try {
            const chan = interactionOrMessage.channel ?? (await interactionOrMessage.user.createDM());
            if (payload.embeds) {
              return chan.send({ embeds: payload.embeds });
            }
            return chan.send(payload.content ?? '\u200B');
          } catch (sendErr) {
            console.error('replySafe: fallback channel/DM send failed', sendErr);
            throw err; // rethrow original for visibility
          }
        }
      } catch (e) {
        // ignore
      }
      // rethrow unexpected errors so caller can log them
      throw err;
    }
  }

  // Message path (normal message object)
  try {
    if (opts.embeds) return interactionOrMessage.reply({ embeds: opts.embeds });
    return interactionOrMessage.reply(content);
  } catch (err) {
    // if even that fails, try channel send
    try {
      const ch = interactionOrMessage.channel;
      if (ch && ch.send) {
        if (opts.embeds) return ch.send({ embeds: opts.embeds });
        return ch.send(content ?? '\u200B');
      }
    } catch (e) {
      console.error('replySafe: message fallback failed', e);
    }
    throw err;
  }
}

export function getUserFromInvocation(interactionOrMessage, args = [], argIndex = 0) {
  // 1) Slash option "user"
  if (isInteraction(interactionOrMessage) && typeof interactionOrMessage.options.getUser === 'function') {
    try {
      const u = interactionOrMessage.options.getUser("user");
      if (u) return u;
    } catch (e) {}
  }

  // 2) Message mentions
  if (interactionOrMessage?.mentions?.users?.first) {
    const m = interactionOrMessage.mentions.users.first();
    if (m) return m;
  }

  // 3) Fallback: args[argIndex] (id string)
  if (args && args[argIndex]) {
    return { id: String(args[argIndex]), tag: String(args[argIndex]) };
  }

  return null;
}

export function getStringOption(interactionOrMessage, name, args = [], argIndex = 0) {
  if (isInteraction(interactionOrMessage) && typeof interactionOrMessage.options.getString === 'function') {
    try {
      return interactionOrMessage.options.getString(name);
    } catch (e) {}
  }
  return args && args[argIndex] !== undefined ? String(args[argIndex]) : null;
}

export function getIntegerOption(interactionOrMessage, name, args = [], argIndex = 1) {
  if (isInteraction(interactionOrMessage) && typeof interactionOrMessage.options.getInteger === 'function') {
    try {
      return interactionOrMessage.options.getInteger(name);
    } catch (e) {}
  }
  if (args && args[argIndex] !== undefined) {
    const v = parseInt(args[argIndex], 10);
    return Number.isFinite(v) ? v : null;
  }
  return null;
}
