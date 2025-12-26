// commands/unban.js
import PlayFab from 'playfab-sdk';
import { replySafe, getStringOption, isInteraction } from '../utils/commandHelpers.js';

export default {
  name: "unban",
  description: "Unban a player",
  options: [
    { name: "id", description: "PlayFab ID of the player", type: 3, required: true }
  ],
  async execute(interactionOrMessage, args = []) {
    const playerId = getStringOption(interactionOrMessage, "id", args, 0);
    if (!playerId) return replySafe(interactionOrMessage, "❌ Provide a PlayFab ID", { ephemeral: true });

    // Używamy RevokeAllBansForUser (usuwa/oznacza jako nieaktywne wszystkie aktywne bany dla użytkownika)
    PlayFab.PlayFabServer.RevokeAllBansForUser({ PlayFabId: playerId }, (err, result) => {
      if (err) {
        // PlayFab error może być w err.errorMessage albo err
        const msg = err?.errorMessage ?? (err?.error ?? JSON.stringify(err));
        return replySafe(interactionOrMessage, `❌ Error: ${msg}`, { ephemeral: true });
      }

      // result będzie zawierać BanData (lista odwołanych banów) — jeśli pusta, nic nie było do revokowania
      const revoked = (result?.data?.BanData && result.data.BanData.length) ? result.data.BanData.length : 0;
      if (revoked > 0) {
        return replySafe(interactionOrMessage, `✅ Unbanned ${revoked} ban(s) for PlayFabId ${playerId}`, { ephemeral: isInteraction(interactionOrMessage) });
      } else {
        return replySafe(interactionOrMessage, `ℹ️ No active bans found for ${playerId}`, { ephemeral: isInteraction(interactionOrMessage) });
      }
    });
  }
};
