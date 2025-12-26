// commands/setmod.js
import GuildConfig from '../models/GuildConfig.js';
import { isInteraction, replySafe, getUserFromInvocation } from '../utils/commandHelpers.js';

export default {
  name: "setmod",
  description: "Add a user to the bot moderators list",
  options: [{ name: "user", description: "User to add as mod", type: 6, required: true }],
  async execute(interactionOrMessage, args = []) {
    const guild = interactionOrMessage.guild;
    if (!guild) return replySafe(interactionOrMessage, "❌ This command can only be used in a server", { ephemeral: true });

    let user = getUserFromInvocation(interactionOrMessage, args, 0);
    if (!user) return replySafe(interactionOrMessage, "❌ Mention a user or provide an ID", { ephemeral: isInteraction(interactionOrMessage) });

    // Jeśli mamy tylko id-like object spróbuj pobrać pełny user
    if (!user.tag && user.id && guild.members) {
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (member) user = member.user;
    }

    let cfg = await GuildConfig.findOne({ guildId: guild.id });
    if (!cfg) cfg = await GuildConfig.create({ guildId: guild.id, mods: [] });

    cfg.mods = cfg.mods || [];
    if (!cfg.mods.includes(user.id)) {
      cfg.mods.push(user.id);
      await cfg.save();
    }

    const replyText = `${user.tag ?? user.id} is now a bot moderator.`;
    return replySafe(interactionOrMessage, replyText, { ephemeral: isInteraction(interactionOrMessage) });
  }
};
