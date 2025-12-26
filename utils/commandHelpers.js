// utils/commandHelpers.js
// Named exports: isInteraction, replySafe, getUserFromInvocation, getStringOption, getIntegerOption

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

export async function replySafe(interactionOrMessage, content, opts = {}) {
  // opts: { embeds, ephemeral }
  if (isInteraction(interactionOrMessage)) {
    const payload = {};
    if (typeof content === 'string' && content.length) payload.content = content;
    if (opts.embeds) payload.embeds = opts.embeds;
    if (opts.ephemeral) payload.ephemeral = true;
    if (Object.keys(payload).length === 0) payload.content = '\u200B';
    // note: if reply was already used, you may need followUp/editReply in your codepath
    return interactionOrMessage.reply(payload);
  } else {
    if (opts.embeds) {
      return interactionOrMessage.reply({ embeds: opts.embeds });
    }
    return interactionOrMessage.reply(content);
  }
}

export function getUserFromInvocation(interactionOrMessage, args = [], argIndex = 0) {
  // 1) Slash option "user"
  if (isInteraction(interactionOrMessage) && typeof interactionOrMessage.options.getUser === 'function') {
    try {
      const u = interactionOrMessage.options.getUser("user");
      if (u) return u;
    } catch (e) { /* ignore */ }
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
    } catch (e) { /* ignore */ }
  }
  return args && args[argIndex] !== undefined ? String(args[argIndex]) : null;
}

export function getIntegerOption(interactionOrMessage, name, args = [], argIndex = 1) {
  if (isInteraction(interactionOrMessage) && typeof interactionOrMessage.options.getInteger === 'function') {
    try {
      return interactionOrMessage.options.getInteger(name);
    } catch (e) { /* ignore */ }
  }
  if (args && args[argIndex] !== undefined) {
    const v = parseInt(args[argIndex], 10);
    return Number.isFinite(v) ? v : null;
  }
  return null;
}
