import GuildConfig from '../models/GuildConfig.js';

export default {
  name: "delmod",
  description: "Remove a user from bot moderators",
  options: [
    {
      name: "user",
      description: "User to remove",
      type: 6, // USER
      required: true
    }
  ],
  async execute(interactionOrMessage, args) {
    let user;
    if (interactionOrMessage.options) {
      user = interactionOrMessage.options.getUser("user");
    } else {
      user = interactionOrMessage.mentions.users.first();
      if (!user) return interactionOrMessage.reply("❌ Mention a user");
    }

    const guildId = interactionOrMessage.guild.id;
    let cfg = await GuildConfig.findOne({ guildId });
    if (!cfg || !cfg.mods.includes(user.id)) {
      return interactionOrMessage.reply("❌ This user is not a bot moderator.");
    }

    cfg.mods = cfg.mods.filter(id => id !== user.id);
    await cfg.save();

    const replyText = `${user.tag} is no longer a bot moderator.`;
    if (interactionOrMessage.reply && !interactionOrMessage.options) {
      interactionOrMessage.reply(replyText);
    } else {
      interactionOrMessage.reply({ content: replyText, flags: 64 });
    }
  }
};
