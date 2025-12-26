import GuildConfig from '../models/GuildConfig.js';

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
  async execute(interactionOrMessage, args) {
    let user;
    let guild;
    if (interactionOrMessage.options?.getUser) {
      // slash
      user = interactionOrMessage.options.getUser("user");
      guild = interactionOrMessage.guild;
    } else {
      // message command
      user = interactionOrMessage.mentions?.users?.first();
      guild = interactionOrMessage.guild;
      if (!user) return interactionOrMessage.reply("❌ Mention a user");
    }

    if (!guild) return interactionOrMessage.reply("❌ This command can only be used in a server");

    let cfg = await GuildConfig.findOne({ guildId: guild.id });
    if (!cfg) cfg = await GuildConfig.create({ guildId: guild.id });

    if (!cfg.mods.includes(user.id)) {
      cfg.mods.push(user.id);
      await cfg.save();
    }

    const replyText = `${user.tag} is now a bot moderator.`;
    if (!interactionOrMessage.options?.getUser) {
      interactionOrMessage.reply(replyText);
    } else {
      interactionOrMessage.reply({ content: replyText, ephemeral: true });
    }
  }
};
