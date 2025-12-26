import PlayFab from 'playfab-sdk';

PlayFab.settings.titleId = "171DCA";

export default {
  name: "info",
  description: "Show PlayFab account info",
  options: [
    {
      name: "id",
      description: "PlayFab ID of the player",
      type: 3, // STRING
      required: true
    }
  ],
  async execute(message, args) {
    const playerId = args[0];
    if (!playerId) return message.reply("❌ Provide a PlayFab ID");

    // PlayFabClient zamiast Client
    PlayFab.PlayFabClient.GetAccountInfo({ PlayFabId: playerId }, (err, result) => {
      if (err) return message.reply(`❌ Error: ${err.errorMessage}`);

      const info = result.data.AccountInfo;
      const stats = `
**DisplayName:** ${info.TitleInfo.DisplayName}
**PlayFabId:** ${info.PlayFabId}
**Created:** ${info.Created}
**Last Login:** ${info.TitleInfo.LastLogin}
      `;

      // Pobierz PlayerData
      PlayFab.PlayFabClient.GetUserData({ PlayFabId: playerId }, (err2, dataResult) => {
        if (!err2 && dataResult.data) {
          const pdata = Object.entries(dataResult.data).map(([k,v]) => `${k}: ${v.Value}`).join("\n");
          message.reply(stats + "\n**PlayerData:**\n" + pdata);
        } else {
          message.reply(stats + "\nNo PlayerData found.");
        }
      });
    });
  }
};