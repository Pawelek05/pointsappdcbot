// commands/setpoints.js
import PlayFab from 'playfab-sdk';
import { replySafe, getStringOption, getIntegerOption, isInteraction } from '../utils/commandHelpers.js';

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
  async execute(interactionOrMessage, args = []) {
    const playerId = getStringOption(interactionOrMessage, "id", args, 0);
    const points = getIntegerOption(interactionOrMessage, "amount", args, 1);

    if (!playerId || points === null || points === undefined) {
      return replySafe(interactionOrMessage, "Usage: setpoints <playfab_id> <amount>", { ephemeral: true });
    }

    PlayFab.PlayFabServer.UpdateUserData({
      PlayFabId: playerId,
      Data: { Money: String(points) }
    }, (err, result) => {
      if (err) return replySafe(interactionOrMessage, `❌ Error: ${err.errorMessage || err}`, { ephemeral: true });
      return replySafe(interactionOrMessage, `✅ Money set to ${points} for PlayFabId ${playerId}`, { ephemeral: isInteraction(interactionOrMessage) });
    });
  }
};
