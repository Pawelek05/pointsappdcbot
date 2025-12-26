export default {
  name: "help",
  description: "Show all commands",
  async execute(message) {
    const helpText = `
**Bot Commands**
\`info <playfab_id>\` - Show player stats from PlayFab
\`setpoints <playfab_id> <number>\` - Set Money value
\`unban <playfab_id>\` - Unban a player
\`setmod @user\` - Add user as bot moderator
\`help\` - Show this help
    `;
    message.reply(helpText);
  }
};
