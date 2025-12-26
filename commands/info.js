import PlayFab from 'playfab-sdk';
import { EmbedBuilder } from 'discord.js';

export default {
  name: "info",
  description: "Show PlayFab player data in an embed",
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

        const pdata = dataResult.data
          ? Object.entries(dataResult.data).map(([k, v]) => `**${k}:** ${v.Value}`).join("\n")
          : "No PlayerData found.";

        const embed = new EmbedBuilder()
          .setTitle(`Player Info: ${info.TitleInfo.DisplayName || playerId}`)
          .setColor(0x00AE86)
          .addFields(
            { name: "PlayFabId", value: info.PlayFabId, inline: true },
            { name: "Created", value: new Date(info.Created).toLocaleString(), inline: true },
            { name: "Last Login", value: info.TitleInfo.LastLogin ? new Date(info.TitleInfo.LastLogin).toLocaleString() : "Never", inline: true },
            { name: "Player Data", value: pdata.length > 1024 ? pdata.slice(0, 1020) + "..." : pdata }
          )
          .setFooter({ text: "PlayFab Info", iconURL: message.client.user.displayAvatarURL() })
          .setTimestamp();

        message.reply({ embeds: [embed] });
      });
    });
  }
};
