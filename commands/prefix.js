// commands/prefix.js
import GuildConfig from '../models/GuildConfig.js';
import { replySafe, isInteraction, getStringOption } from '../utils/commandHelpers.js';

export default {
  name: "prefix",
  description: "Change the bot prefix for this server",
  options: [
    { name: "prefix", description: "New prefix to use", type: 3, required: true }
  ],
  async execute(interactionOrMessage, args = []) {
    const guild = interactionOrMessage.guild;
    if (!guild) return replySafe(interactionOrMessage, "❌ This command can only be used in a server", { ephemeral: true });

    const newPrefix = getStringOption(interactionOrMessage, "prefix", args, 0);
    if (!newPrefix) return replySafe(interactionOrMessage, "❌ Provide a new prefix, e.g., `!prefix ?`", { ephemeral: true });

    let cfg = await GuildConfig.findOne({ guildId: guild.id });
    if (!cfg) cfg = await GuildConfig.create({ guildId: guild.id });

    cfg.prefix = newPrefix;
    await cfg.save();

    return replySafe(interactionOrMessage, `✅ Prefix set to \`${newPrefix}\``, { ephemeral: isInteraction(interactionOrMessage) });
  }
};
