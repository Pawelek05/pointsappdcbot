import PlayFab from 'playfab-sdk';

export default {
  name: "unban",
  description: "Unban a player",
  options: [
    {
      name: "id",
      description: "PlayFab ID of the player",
      type: 3,
      required: true
    }
  ],
  async execute(interaction) {
    const playerId = interaction.options.getString("id");
    if (!playerId) return interaction.reply({ content: "❌ Provide a PlayFab ID", ephemeral: true });

    PlayFab.PlayFabServer.RevokeBans({ PlayFabId: playerId }, (err, result) => {
      if (err) return interaction.reply({ content: `❌ Error: ${err.errorMessage}`, ephemeral: true });

      interaction.reply({ content: `✅ Player ${playerId} has been unbanned.`, ephemeral: true });
    });
  }
};
