// commands/info.js
import PlayFab from 'playfab-sdk';
import { EmbedBuilder } from 'discord.js';
import { replySafe, isInteraction, getStringOption } from '../utils/commandHelpers.js';

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
  async execute(interactionOrMessage, args = []) {
    const playerId = getStringOption(interactionOrMessage, "id", args, 0);
    if (!playerId) return replySafe(interactionOrMessage, "❌ Provide a PlayFab ID", { ephemeral: true });

    PlayFab.PlayFabServer.GetUserAccountInfo({ PlayFabId: playerId }, (err, result) => {
      if (err) {
        return replySafe(interactionOrMessage, `❌ Error: ${err.errorMessage || err}`, { ephemeral: true });
      }

      const info = result?.data?.UserInfo;
      if (!info) {
        return replySafe(interactionOrMessage, `❌ No user info found for ${playerId}`, { ephemeral: true });
      }

      PlayFab.PlayFabServer.GetUserData({ PlayFabId: playerId }, (err2, dataResult) => {
        if (err2) return replySafe(interactionOrMessage, `❌ Error fetching PlayerData: ${err2.errorMessage || err2}`, { ephemeral: true });

        const pdata = dataResult?.data?.Data || {};

        const money = pdata.Money?.Value ?? "0";
        const ads = pdata.Ads?.Value ?? "0";
        const lastReset = pdata.LastResetTime?.Value ?? "N/A";

        const embed = new EmbedBuilder()
          .setTitle(`Player Info: ${info?.TitleInfo?.DisplayName ?? playerId}`)
          .addFields(
            { name: "PlayFabId", value: info.PlayFabId ?? playerId, inline: true },
            { name: "Created", value: info.Created ?? "N/A", inline: true },
            { name: "Last Login", value: info?.TitleInfo?.LastLogin ?? "N/A", inline: true },
            { name: "Money", value: String(money), inline: true },
            { name: "Ads", value: String(ads), inline: true },
            { name: "LastResetTime", value: String(lastReset), inline: true }
          );

        return replySafe(interactionOrMessage, null, { embeds: [embed], ephemeral: isInteraction(interactionOrMessage) });
      });
    });
  }
};
