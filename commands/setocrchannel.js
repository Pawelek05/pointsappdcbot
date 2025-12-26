// commands/setocrchannel.js
import GuildConfig from '../models/GuildConfig.js';
import { isInteraction, replySafe, getStringOption } from '../utils/commandHelpers.js';

export default {
  name: "setocrchannel",
  description: "Set channel where bot will OCR uploaded images",
  options: [
    { name: "channel", description: "Channel to monitor", type: 7, required: true } // 7 = CHANNEL
  ],
  async execute(interactionOrMessage, args = []) {
    const guild = interactionOrMessage.guild ?? (interactionOrMessage.guildId ? await interactionOrMessage.client.guilds.fetch(interactionOrMessage.guildId).catch(()=>null) : null);
    if (!guild) return replySafe(interactionOrMessage, "❌ This command can only be used in a server", { ephemeral: true });

    let channelId = null;

    if (isInteraction(interactionOrMessage) && typeof interactionOrMessage.options.getChannel === 'function') {
      const c = interactionOrMessage.options.getChannel('channel');
      channelId = c?.id;
    } else {
      // prefix: args[0] might be mention <#ID> or raw id
      const raw = args[0] || getStringOption?.(interactionOrMessage, 'channel', args, 0);
      if (!raw) return replySafe(interactionOrMessage, "❌ Provide a channel mention or ID", { ephemeral: true });
      const mentionMatch = raw.match(/^<#?(\d+)>$/) || raw.match(/^<#!?(\d+)>$/);
      channelId = mentionMatch ? mentionMatch[1] : raw;
    }

    if (!channelId) return replySafe(interactionOrMessage, "❌ Invalid channel", { ephemeral: true });

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) return replySafe(interactionOrMessage, "❌ Channel not found in this server", { ephemeral: true });

    let cfg = await GuildConfig.findOne({ guildId: guild.id });
    if (!cfg) cfg = await GuildConfig.create({ guildId: guild.id });

    cfg.ocrChannelId = channelId;
    await cfg.save();

    return replySafe(interactionOrMessage, `✅ OCR channel set to <#${channelId}>`, { ephemeral: isInteraction(interactionOrMessage) });
  }
};
