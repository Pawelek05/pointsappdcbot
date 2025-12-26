import GuildConfig from '../models/GuildConfig.js';
import { isInteraction, replySafe, getUserFromInvocation } from '../utils/commandHelpers.js';

export default {
  name: "delmod",
  description: "Remove a user from bot moderators",
  options: [
    {
      name: "user",
      description: "User to remove as mod",
      type: 6, // USER
      required: true
    }
  ],
  async execute(interactionOrMessage, args = []) {
    const guild = interactionOrMessage.guild;
    if (!guild) return replySafe(interactionOrMessage, "❌ This command can only be used in a server", { ephemeral: true });

    let user = getUserFromInvocation(interactionOrMessage, 0, args);
    if (!user) return replySafe(interactionOrMessage, "❌ Mention a user or provide an ID");

    if (!user.tag && guild.members) {
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (member) user = member.user;
    }

    let cfg = await GuildConfig.findOne({ guildId: guild.id });
    if (!cfg) return replySafe(interactionOrMessage, "❌ No configuration found for this server", { ephemeral: true });

    cfg.mods = cfg.mods || [];
    const index = cfg.mods.indexOf(user.id);
    if (index !== -1) {
      cfg.mods.splice(index, 1);
      await cfg.save();
      const replyText = `${user.tag ?? user.id} is no longer a bot moderator.`;
      return replySafe(interactionOrMessage, replyText, { ephemeral: isInteraction(interactionOrMessage) });
    } else {
      return replySafe(interactionOrMessage, "❌ This user is not a bot moderator.", { ephemeral: isInteraction(interactionOrMessage) });
    }
  }
};
