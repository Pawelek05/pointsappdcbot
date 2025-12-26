import PlayFab from 'playfab-sdk';
PlayFab.settings.titleId = "171DCA";

export default {
  name: "unban",
  description: "Unban a player",
  async execute(message, args) {
    const playerId = args[0];
    if (!playerId) return message.reply("Provide a PlayFab ID");

    PlayFab.Client.UpdateUserData({
      PlayFabId: playerId,
      Data: { IsBanned: "0", BannedUntil: "" }
    }, (err, result) => {
      if (err) return message.reply(`Error: ${err.errorMessage}`);
      message.reply(`✅ Player ${playerId} unbanned`);
    });
  }
};
