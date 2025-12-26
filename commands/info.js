import PlayFab from 'playfab-sdk';
import { EmbedBuilder } from 'discord.js';

export default {
  name: "info",
  description: "Show PlayFab player info and selected PlayerData",
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

    // Pobranie danych konta
    PlayFab.PlayFabServer.GetUserAccountInfo({ PlayFabId: playerId }, (err, result) => {
      if (err) return message.reply(`❌ Error: ${err.errorMessage}`);

      const info = result.data.UserInfo;

      // Pobranie PlayerData
      PlayFab.PlayFabServer.GetUserData({ PlayFabId: playerId }, (err2, dataResult) => {
        if (err2) return message.reply(`❌ Error fetching PlayerData: ${err2.errorMessage}`);

        // Wybór tylko potrzebnych zmiennych
        const data = dataResult.data || {};
        const money = data.Money?.Value ?? "0";
        const ads = data.Ads?.Value ?? "0";
        const lastReset = data.LastResetTime?.Value ?? "Never";

        const embed = new EmbedBuilder()
          .setTitle(`Player Info: ${info.TitleInfo.DisplayName || playerId}`)
          .setColor(0x00AE86)
          .addFields(
            { name: "DisplayName", value: info.TitleInfo.DisplayName || "N/A", inline: true },
            { name: "Created", value: new Date(info.Created).toLocaleString(), inline: true },
            { name: "Last Login", value: info.TitleInfo.LastLogin ? new Date(info.TitleInfo.LastLogin).toLocaleString() : "Never", inline: true },
            { name: "Coins", value: money, inline: true },
            { name: "Ads", value: ads, inline: true },
            { name: "LastResetTime", value: lastReset, inline: true }
          )
          .setFooter({ text: "PlayFab Info", iconURL: message.client.user.displayAvatarURL() })
          .setTimestamp();

        message.reply({ embeds: [embed] });
      });
    });
  }
};
