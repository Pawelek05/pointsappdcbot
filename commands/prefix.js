import GuildConfig from '../models/GuildConfig.js';

export default {
  name: "prefix",
  description: "Change the bot prefix for this server",
  async execute(message, args) {
    const newPrefix = args[0];
    if (!newPrefix) return message.reply("Provide a new prefix, e.g., `!prefix ?`");

    let cfg = await GuildConfig.findOne({ guildId: message.guild.id });
    if (!cfg) cfg = await GuildConfig.create({ guildId: message.guild.id });

    cfg.prefix = newPrefix;
    await cfg.save();
    message.reply(`✅ Prefix set to \`${newPrefix}\``);
  }
};
