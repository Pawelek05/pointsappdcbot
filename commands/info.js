import PlayFab from 'playfab-sdk';
import { EmbedBuilder } from 'discord.js';

export default {
  name: "info",
  description: "Show PlayFab account info",
  options: [
    {
      name: "id",
      description: "PlayFab ID of the player",
      type: 3,
      required: true
    }
  ],
  async execute(interactionOrMessage, args) {
    const playerId = interactionOrMessage.options?.getString
      ? interactionOrMessage.options.getString("id")
      : args[0];

    if (!playerId) return interactionOrMessage.reply("❌ Provide a PlayFab ID");

    PlayFab.PlayFabServer.GetUserAccountInfo({ PlayFabId: playerId }, (err, result) => {
      if (err) return interactionOrMessage.reply(`❌ Error: ${err.errorMessage}`);

      const info = result.data.UserInfo;

      // Pobranie PlayerData
      PlayFab.PlayFabServer.GetUserData({ PlayFabId: playerId }, (err2, dataResult) => {
        if (err2) return interactionOrMessage.reply(`❌ Error fetching PlayerData: ${err2.errorMessage}`);

        const data = dataResult.data || {};
        const money = data.Money?.Value || "0";
        const ads = data.Ads?.Value || "0";
        const lastReset = data.LastResetTime?.Value || "N/A";

        const embed = new EmbedBuilder()
          .setTitle(`Player Info: ${info.TitleInfo.DisplayName}`)
          .addFields(
            { name: "PlayFabId", value: info.PlayFabId, inline: true },
            { name: "Created", value: info.Created, inline: true },
            { name: "Last Login", value: info.TitleInfo.LastLogin, inline: true },
            { name: "Coins", value: money, inline: true },
            { name: "Ads", value: ads, inline: true },
            { name: "LastResetTime", value: lastReset, inline: true }
          );

        if (interactionOrMessage.reply && !interactionOrMessage.options) {
          interactionOrMessage.reply({ embeds: [embed] });
        } else {
          interactionOrMessage.reply({ embeds: [embed], flags: 64 });
        }
      });
    });
  }
};
