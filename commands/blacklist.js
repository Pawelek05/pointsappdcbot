// commands/blacklist.js
import { EmbedBuilder } from 'discord.js';
import { replySafe, isInteraction, getStringOption } from '../utils/commandHelpers.js';
import isMod from '../utils/isMod.js';
import GuildConfig from '../models/GuildConfig.js';

export default {
  name: "blacklist",
  description: "Manage reward claim blacklist (moderators only)",
  options: [
    {
      name: "add",
      description: "Add a user to the reward blacklist",
      type: 1,
      options: [
        { name: "user", description: "User to blacklist (mention or ID)", type: 6, required: true }
      ]
    },
    {
      name: "remove",
      description: "Remove a user from the reward blacklist",
      type: 1,
      options: [
        { name: "user", description: "User to remove from blacklist (mention or ID)", type: 6, required: true }
      ]
    },
    {
      name: "list",
      description: "List blacklisted users in this guild",
      type: 1
    }
  ],
  async execute(interactionOrMessage, args = []) {
    const isInt = isInteraction(interactionOrMessage);
    const sub = isInt ? ( (() => { try { return interactionOrMessage.options.getSubcommand(false); } catch(e){ return null; } })() ) : args[0];
    const guildId = interactionOrMessage.guild?.id;
    const userId = interactionOrMessage.user?.id ?? interactionOrMessage.author?.id;

    // permission check
    const allowed = await isMod(userId, guildId);
    if (!allowed) return replySafe(interactionOrMessage, "❌ You need moderator permissions to manage the blacklist.", { ephemeral: true });

    if (!sub) return replySafe(interactionOrMessage, "Use subcommands: add / remove / list", { ephemeral: true });

    try {
      if (sub === "add") {
        // for interactions, option type 6 returns a User object; for messages we expect an ID in args[1]
        let targetUser = null;
        if (isInt) {
          targetUser = interactionOrMessage.options.getUser("user");
        } else {
          // fallback: try to accept a plain ID string
          const idArg = args[1];
          if (idArg) targetUser = { id: String(idArg) };
        }
        if (!targetUser) return replySafe(interactionOrMessage, "❌ Could not determine the target user to blacklist. Provide a mention or ID.", { ephemeral: true });

        const targetId = String(targetUser.id);

        const updated = await GuildConfig.findOneAndUpdate(
          { guildId },
          { $addToSet: { blacklist: targetId } },
          { upsert: true, new: true }
        );

        const embed = new EmbedBuilder()
          .setTitle("User Blacklisted")
          .setColor(0xE74C3C)
          .setDescription(`✅ <@${targetId}> has been added to the reward blacklist.`)
          .setFooter({ text: "Blacklisted users cannot claim rewards" })
          .setTimestamp();

        return replySafe(interactionOrMessage, null, { embeds: [embed], ephemeral: true });
      }

      if (sub === "remove") {
        let targetUser = null;
        if (isInt) {
          targetUser = interactionOrMessage.options.getUser("user");
        } else {
          const idArg = args[1];
          if (idArg) targetUser = { id: String(idArg) };
        }
        if (!targetUser) return replySafe(interactionOrMessage, "❌ Could not determine the target user to remove. Provide a mention or ID.", { ephemeral: true });

        const targetId = String(targetUser.id);

        const updated = await GuildConfig.findOneAndUpdate(
          { guildId },
          { $pull: { blacklist: targetId } },
          { new: true }
        );

        const embed = new EmbedBuilder()
          .setTitle("User Removed from Blacklist")
          .setColor(0x2ECC71)
          .setDescription(`✅ <@${targetId}> has been removed from the reward blacklist.`)
          .setFooter({ text: "They can now claim rewards again" })
          .setTimestamp();

        return replySafe(interactionOrMessage, null, { embeds: [embed], ephemeral: true });
      }

      if (sub === "list") {
        const cfg = await GuildConfig.findOne({ guildId });
        const list = (cfg?.blacklist && cfg.blacklist.length) ? cfg.blacklist : [];

        const embed = new EmbedBuilder()
          .setTitle("Blacklisted Users")
          .setColor(0xF1C40F)
          .setTimestamp();

        if (list.length === 0) {
          embed.setDescription("No users are currently blacklisted for rewards in this guild.");
        } else {
          // show up to 25 entries (sensible limit)
          const lines = list.slice(0, 25).map(id => `• <@${id}> (\`${id}\`)`);
          embed.setDescription(lines.join("\n"));
          if (list.length > 25) embed.addFields({ name: "Note", value: `Only showing first 25 of ${list.length} entries.` });
        }

        return replySafe(interactionOrMessage, null, { embeds: [embed], ephemeral: true });
      }

      return replySafe(interactionOrMessage, "Unknown subcommand. Use: add / remove / list", { ephemeral: true });
    } catch (err) {
      console.error("Blacklist command error:", err);
      return replySafe(interactionOrMessage, `❌ An error occurred: ${err.message}`, { ephemeral: true });
    }
  }
};
