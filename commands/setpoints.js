import PlayFab from 'playfab-sdk';
PlayFab.settings.titleId = "171DCA";

export default {
  name: "setpoints",
  description: "Set player Money",
  async execute(message, args) {
    const [playerId, points] = args;
    if (!playerId || !points) return message.reply("Usage: setpoints <playfab_id> <number>");

    PlayFab.Client.UpdateUserData({
      PlayFabId: playerId,
      Data: { Money: points }
    }, (err, result) => {
      if (err) return message.reply(`Error: ${err.errorMessage}`);
      message.reply(`✅ Money set to ${points} for PlayFabId ${playerId}`);
    });
  }
};
