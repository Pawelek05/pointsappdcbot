import GuildConfig from '../models/GuildConfig.js';

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
  async execute(interactionOrMessage, args) {
    let user;
    let guild;

    if (interactionOrMessage.options?.getUser) {
      user = interactionOrMessage.options.getUser("user");
      guild = interactionOrMessage.guild;
    } else {
      user = interactionOrMessage.mentions?.users?.first();
      guild = interactionOrMessage.guild;
      if (!user) return interactionOrMessage.reply("❌ Mention a user");
    }

    if (!guild) return interactionOrMessage.reply("❌ This command can only be used in a server");

    let cfg = await GuildConfig.findOne({ guildId: guild.id });
    if (!cfg) return interactionOrMessage.reply("❌ No configuration found for this server");

    const index = cfg.mods.indexOf(user.id);
    if (index !== -1) {
      cfg.mods.splice(index, 1);
      await cfg.save();
      const replyText = `${user.tag} is no longer a bot moderator.`;
      if (interactionOrMessage.options?.getUser) {
        interactionOrMessage.reply({ content: replyText, ephemeral: true });
      } else {
        interactionOrMessage.reply(replyText);
      }
    } else {
      interactionOrMessage.reply("❌ This user is not a bot moderator.");
    }
  }
};
