import GuildConfig from '../models/GuildConfig.js';

export default {
  name: "setmod",
  description: "Add a user to the bot moderators list",
  options: [
    {
      name: "user",
      description: "Select a user to make moderator",
      type: 6, // USER type
      required: true
    }
  ],
  async execute(interaction) {
    const user = interaction.options.getUser("user");
    if (!user) return interaction.reply({ content: "❌ Mention a user", ephemeral: true });

    let cfg = await GuildConfig.findOne({ guildId: interaction.guildId });
    if (!cfg) cfg = await GuildConfig.create({ guildId: interaction.guildId });

    if (!cfg.mods.includes(user.id)) {
      cfg.mods.push(user.id);
      await cfg.save();
    }

    return interaction.reply({ content: `${user.tag} is now a bot moderator.`, ephemeral: true });
  }
};
