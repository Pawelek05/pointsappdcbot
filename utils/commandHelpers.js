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

export async function replySafe(interactionOrMessage, content, opts = {}) {
  // opts: { embeds, ephemeral, components }
  if (isInteraction(interactionOrMessage)) {
    const payload = {};
    if (typeof content === 'string' && content.length) payload.content = content;
    if (opts.embeds) payload.embeds = opts.embeds;
    if (opts.components) payload.components = opts.components;
    if (opts.ephemeral) payload.ephemeral = true;
    if (Object.keys(payload).length === 0) payload.content = '\u200B';
    return interactionOrMessage.reply(payload);
  } else {
    // message-based
    const sendPayload = {};
    if (typeof content === 'string' && content.length) sendPayload.content = content;
    if (opts.embeds) sendPayload.embeds = opts.embeds;
    if (opts.components) sendPayload.components = opts.components;
    if (Object.keys(sendPayload).length === 0) sendPayload.content = '\u200B';
    return interactionOrMessage.reply(sendPayload);
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
