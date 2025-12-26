// utils/commandHelpers.js
export function isInteraction(obj) {
  // Bezpieczne sprawdzenie czy mamy slash interaction (ChatInput)
  return typeof obj?.options === 'object' && (typeof obj.options.get === 'function' || typeof obj.options.getUser === 'function');
}

export async function replySafe(interactionOrMessage, content, opts = {}) {
  // opts: { embeds, ephemeral }
  if (isInteraction(interactionOrMessage)) {
    // jeśli już reply było wysłane, możesz użyć editReply / followUp - tu przyjmujemy proste reply
    return interactionOrMessage.reply({ content, embeds: opts.embeds, ephemeral: !!opts.ephemeral });
  } else {
    return interactionOrMessage.reply(content);
  }
}

export function getUserFromInvocation(interactionOrMessage, argIndex = 0, args = []) {
  // 1) Slash: options.getUser("user")
  if (typeof interactionOrMessage?.options?.getUser === 'function') {
    return interactionOrMessage.options.getUser("user");
  }
  // 2) Message mentions
  if (interactionOrMessage?.mentions?.users?.first) {
    const m = interactionOrMessage.mentions.users.first();
    if (m) return m;
  }
  // 3) Fallback: args[argIndex] jako id (string) - return an object-like with id if you need
  if (args && args[argIndex]) {
    // return a minimal object { id: args[argIndex] } - caller may want to fetch user by id
    return { id: args[argIndex], tag: args[argIndex] };
  }
  return null;
}
