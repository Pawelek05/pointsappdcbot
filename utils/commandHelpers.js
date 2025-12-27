// utils/commandHelpers.js

export function isInteraction(obj) {
  return !!(
    obj &&
    typeof obj === 'object' &&
    obj.options &&
    (typeof obj.options.get === 'function' ||
      typeof obj.options.getUser === 'function' ||
      typeof obj.options.getString === 'function' ||
      typeof obj.options.getInteger === 'function' ||
      typeof obj.options.getNumber === 'function')
  );
}

/**
 * replySafe(interactionOrMessage, content, opts = {})
 * - interactionOrMessage: Interaction or Message
 * - content: string (optional if embeds provided)
 * - opts: { embeds, components, ephemeral }
 *
 * Behavior:
 * - For Interactions:
 *    * if deferred => editReply(payload)
 *    * else if replied => followUp(payload)
 *    * else => reply(payload)
 * - If the interaction is unknown/expired (Discord code 10062) => fallback to sending to channel or DM
 * - For message objects => message.reply(...) with fallback to channel.send(...)
 */
export async function replySafe(interactionOrMessage, content, opts = {}) {
  // build payloads
  const payload = {};
  if (typeof content === 'string' && content.length) payload.content = content;
  if (opts.embeds) payload.embeds = opts.embeds;
  if (opts.components) payload.components = opts.components;

  // ephemeral only meaningful for initial interaction reply
  const ephemeral = !!opts.ephemeral;

  // ensure we never send an empty payload to Discord
  if (Object.keys(payload).length === 0) payload.content = '\u200B';

  // Interaction path
  if (isInteraction(interactionOrMessage)) {
    try {
      // If message should be ephemeral and we are replying, attach flag only when calling reply()
      const replyPayload = { ...payload };
      if (ephemeral) replyPayload.ephemeral = true;

      // If already deferred => editReply
      if (interactionOrMessage.deferred) {
        return await interactionOrMessage.editReply(replyPayload);
      }

      // If already replied => followUp (followUps cannot be ephemeral in many cases)
      if (interactionOrMessage.replied) {
        // followUp doesn't support ephemeral reliably; remove ephemeral flag if present
        if (replyPayload.ephemeral) delete replyPayload.ephemeral;
        return await interactionOrMessage.followUp(replyPayload);
      }

      // else -> reply
      return await interactionOrMessage.reply(replyPayload);
    } catch (err) {
      // handle Unknown interaction (10062) and fallback to channel/DM
      try {
        const code = err?.code ?? err?.rawError?.code ?? null;
        if (code === 10062) {
          // Interaction expired or unknown — fallback to channel or DM send
          try {
            // prefer channel if available
            const channel = interactionOrMessage.channel ?? null;
            if (channel && typeof channel.send === 'function') {
              // send embeds/components or text to channel
              if (payload.embeds || payload.components) {
                return channel.send({
                  content: payload.content ?? '\u200B',
                  embeds: payload.embeds,
                  components: payload.components
                });
              }
              return channel.send(payload.content ?? '\u200B');
            }

            // fallback to DM to the user
            const user = interactionOrMessage.user ?? interactionOrMessage.user;
            if (user && typeof user.createDM === 'function') {
              const dm = await user.createDM();
              if (payload.embeds || payload.components) {
                return dm.send({
                  content: payload.content ?? '\u200B',
                  embeds: payload.embeds,
                  components: payload.components
                });
              }
              return dm.send(payload.content ?? '\u200B');
            }
          } catch (fallbackErr) {
            console.error('replySafe: fallback send failed', fallbackErr);
            // rethrow original err for visibility
            throw err;
          }
        }
      } catch (e) {
        // ignore
      }
      // rethrow unexpected errors
      throw err;
    }
  }

  // Message object path
  try {
    const sendPayload = {};
    if (payload.content) sendPayload.content = payload.content;
    if (payload.embeds) sendPayload.embeds = payload.embeds;
    if (payload.components) sendPayload.components = payload.components;

    if (Object.keys(sendPayload).length === 0) sendPayload.content = '\u200B';
    return await interactionOrMessage.reply(sendPayload);
  } catch (err) {
    // fallback to channel.send if message.reply fails
    try {
      const ch = interactionOrMessage.channel;
      if (ch && typeof ch.send === 'function') {
        const sendPayload = {};
        if (payload.content) sendPayload.content = payload.content;
        if (payload.embeds) sendPayload.embeds = payload.embeds;
        if (payload.components) sendPayload.components = payload.components;
        if (Object.keys(sendPayload).length === 0) sendPayload.content = '\u200B';
        return await ch.send(sendPayload);
      }
    } catch (e) {
      console.error('replySafe: fallback channel send failed', e);
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
  // Try slash-integer first
  if (isInteraction(interactionOrMessage) && typeof interactionOrMessage.options.getInteger === 'function') {
    try {
      const v = interactionOrMessage.options.getInteger(name);
      if (v !== null && v !== undefined) return v;
    } catch (e) {}
  }

  // If not found, try slash-number (float) and coerce to integer
  if (isInteraction(interactionOrMessage) && typeof interactionOrMessage.options.getNumber === 'function') {
    try {
      const nv = interactionOrMessage.options.getNumber(name);
      if (nv !== null && nv !== undefined) {
        const iv = parseInt(nv, 10);
        return Number.isFinite(iv) ? iv : null;
      }
    } catch (e) {}
  }

  // Fallback: check args array (positional)
  if (args && args[argIndex] !== undefined) {
    const v = parseInt(args[argIndex], 10);
    return Number.isFinite(v) ? v : null;
  }
  return null;
}
