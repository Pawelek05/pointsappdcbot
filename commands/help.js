// commands/help.js
import { replySafe, isInteraction } from '../utils/commandHelpers.js';

export default {
  name: "help",
  description: "Show all commands",
  async execute(interactionOrMessage, args = []) {
    const helpText = `
**Bot Commands**
\`info <playfab_id>\` - Show player stats from PlayFab
\`setpoints <playfab_id> <number>\` - Set Money value
\`unban <playfab_id>\` - Unban a player
\`modlist\` - Show app moderators list
\`reward\` - Coin app rewards
\`addcreature\` - Add creature for player
    `;
    return replySafe(interactionOrMessage, helpText, { ephemeral: isInteraction(interactionOrMessage) });
  }
};
