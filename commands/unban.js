// commands/unban.js
import PlayFab from 'playfab-sdk';
import { replySafe, getStringOption, isInteraction } from '../utils/commandHelpers.js';

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
  async execute(interactionOrMessage, args = []) {
    const playerId = getStringOption(interactionOrMessage, "id", args, 0);
    if (!playerId) return replySafe(interactionOrMessage, "❌ Provide a PlayFab ID", { ephemeral: true });

    PlayFab.PlayFabServer.RevokeBans({ PlayFabId: playerId }, (err, result) => {
      if (err) return replySafe(interactionOrMessage, `❌ Error: ${err.errorMessage || err}`, { ephemeral: true });
      return replySafe(interactionOrMessage, `✅ Player ${playerId} has been unbanned.`, { ephemeral: isInteraction(interactionOrMessage) });
    });
  }
};
