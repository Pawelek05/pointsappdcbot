import GuildConfig from '../models/GuildConfig.js';
import { isInteraction, replySafe, getUserFromInvocation } from '../utils/commandHelpers.js';

export default {
  name: "setmod",
  description: "Add a user to the bot moderators list",
  options: [
    {
      name: "user",
      description: "User to add as mod",
      type: 6, // USER
      required: true
    }
  ],
  async execute(interactionOrMessage, args = []) {
    const guild = interactionOrMessage.guild;
    if (!guild) return replySafe(interactionOrMessage, "❌ This command can only be used in a server", { ephemeral: true });

    // Pobierz usera bezpiecznie (slash -> options.getUser, message -> mention lub id w args)
    let user = getUserFromInvocation(interactionOrMessage, 0, args);
    if (!user) return replySafe(interactionOrMessage, "❌ Mention a user or provide an ID");

    // Jeśli user jest 'shallow' obiektem (tylko id z args), spróbuj pobrać pełny obiekt z guild
    if (!user.tag && guild.members) {
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
