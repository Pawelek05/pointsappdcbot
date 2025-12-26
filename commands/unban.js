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
  async execute(message, args) {
    const playerId = args[0];
    if (!playerId) return message.reply("❌ Provide a PlayFab ID");

    PlayFab.PlayFabServer.UpdateUserData({
      PlayFabId: playerId,
      Data: { IsBanned: "0", BannedUntil: "" }
    }, (err, result) => {
      if (err) return message.reply(`❌ Error: ${err.errorMessage}`);
      message.reply(`✅ Player ${playerId} unbanned`);
    });
  }
};
