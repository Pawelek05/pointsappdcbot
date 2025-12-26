import PlayFab from 'playfab-sdk';

export default {
  name: "setpoints",
  description: "Set player Money",
  options: [
    {
      name: "id",
      description: "PlayFab ID of the player",
      type: 3,
      required: true
    },
    {
      name: "amount",
      description: "Amount of Money",
      type: 4, // INTEGER
      required: true
    }
  ],
  async execute(message, args) {
    const [playerId, points] = args;
    if (!playerId || points === undefined) return message.reply("Usage: /setpoints <id> <amount>");

    PlayFab.PlayFabServer.UpdateUserData({
      PlayFabId: playerId,
      Data: { Money: points }
    }, (err, result) => {
      if (err) return message.reply(`❌ Error: ${err.errorMessage}`);
      message.reply(`✅ Money set to ${points} for PlayFabId ${playerId}`);
    });
  }
};
