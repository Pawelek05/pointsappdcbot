// commands/modlist.js
import GuildConfig from '../models/GuildConfig.js';
import { replySafe, isInteraction } from '../utils/commandHelpers.js';
import { EmbedBuilder } from 'discord.js';

export default {
  name: "modlist",
  description: "Show list of bot moderators for this server",
  async execute(interactionOrMessage, args = []) {
    const guild = interactionOrMessage.guild;
    if (!guild) return replySafe(interactionOrMessage, "❌ This command can only be used in a server", { ephemeral: true });

    const cfg = await GuildConfig.findOne({ guildId: guild.id });
    const mods = (cfg && cfg.mods) ? cfg.mods : [];

    if (mods.length === 0) {
      return replySafe(interactionOrMessage, "ℹ️ No bot moderators set for this server.", { ephemeral: isInteraction(interactionOrMessage) });
    }

    // Spróbuj pobrać członków, jeśli nie dostępny to pokaż id
    const lines = await Promise.all(mods.map(async (id) => {
      const member = await guild.members.fetch(id).catch(() => null);
      if (member) return `${member.user.tag} (<@${id}>)`;
      return id;
    }));

    const embed = new EmbedBuilder()
      .setTitle("Bot Moderators")
      .setDescription(lines.join('\n'));

    return replySafe(interactionOrMessage, null, { embeds: [embed], ephemeral: isInteraction(interactionOrMessage) });
  }
};
