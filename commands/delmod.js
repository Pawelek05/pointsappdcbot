// commands/delmod.js
import GuildConfig from '../models/GuildConfig.js';
import { isInteraction, replySafe, getUserFromInvocation } from '../utils/commandHelpers.js';

export default {
  name: "delmod",
  description: "Remove a user from bot moderators",
  options: [{ name: "user", description: "User to remove as mod", type: 6, required: true }],
  async execute(interactionOrMessage, args = []) {
    const guild = interactionOrMessage.guild;
    if (!guild) return replySafe(interactionOrMessage, "❌ This command can only be used in a server", { ephemeral: true });

    let user = getUserFromInvocation(interactionOrMessage, args, 0);
    if (!user) return replySafe(interactionOrMessage, "❌ Mention a user or provide an ID", { ephemeral: isInteraction(interactionOrMessage) });

    if (!user.tag && user.id && guild.members) {
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
