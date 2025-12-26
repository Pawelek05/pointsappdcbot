import GuildConfig from '../models/GuildConfig.js';

export default {
  name: "setmod",
  description: "Add a user to the bot moderators list",
  async execute(message, args) {
    const user = message.mentions.users.first();
    if (!user) return message.reply("Mention a user");

    let cfg = await GuildConfig.findOne({ guildId: message.guild.id });
    if (!cfg) cfg = await GuildConfig.create({ guildId: message.guild.id });

    if (!cfg.mods.includes(user.id)) {
      cfg.mods.push(user.id);
      await cfg.save();
    }

    message.reply(`${user.tag} is now a bot moderator.`);
  }
};
