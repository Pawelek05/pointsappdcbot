// commands/addcreature.js
import axios from 'axios';
import { EmbedBuilder } from 'discord.js';
import { replySafe, isInteraction, getStringOption, getIntegerOption } from '../utils/commandHelpers.js';
import isMod from '../utils/isMod.js';

export default {
  name: "addcreature",
  description: "Add a creature to a player's inventory (mods only)",
  options: [
    { name: "cardwarsid", description: "CardWars ID (multiplayer name or username)", type: 3, required: true },
    { name: "creature", description: "Creature ID (e.g. CornBall_Base or GhostRex_Special)", type: 3, required: true },
    { name: "starrating", description: "Star rating (1-5) - optional", type: 4, required: false }
  ],
  async execute(interactionOrMessage, args = []) {
    const isInt = isInteraction(interactionOrMessage);
    const guildId = interactionOrMessage.guild?.id;
    const userId = interactionOrMessage.user?.id ?? interactionOrMessage.author?.id;

    // permission check
    const allowed = await isMod(userId, guildId);
    if (!allowed) return replySafe(interactionOrMessage, "❌ Only moderators can use this command.", { ephemeral: true });

    const cardwarsId = getStringOption(interactionOrMessage, "cardwarsid", args, 0);
    const creatureId = getStringOption(interactionOrMessage, "creature", args, 1);
    const starRatingOpt = getIntegerOption(interactionOrMessage, "starrating", args, 2);

    if (!cardwarsId || !creatureId) return replySafe(interactionOrMessage, "❌ Usage: /addcreature <cardwarsid> <creature> [starrating]", { ephemeral: true });

    let starRating = 1;
    if (starRatingOpt !== null && starRatingOpt !== undefined) {
      starRating = Number(starRatingOpt);
      if (!Number.isFinite(starRating) || starRating < 1 || starRating > 5) {
        return replySafe(interactionOrMessage, "❌ starRating must be an integer between 1 and 5.", { ephemeral: true });
      }
    }

    // prepare endpoint and auth
    const endpointBase = process.env.PYAN_ENDPOINT;
    if (!endpointBase) return replySafe(interactionOrMessage, "❌ Server endpoint not configured (PYAN_ENDPOINT). Contact an admin.", { ephemeral: true });

    const url = endpointBase.replace(/\/$/, '') + '/api/add_creature';
    const apiKey = process.env.PYAN_API_KEY;
    const body = {
      cardwars_id: cardwarsId,
      creature_id: creatureId,
      star_rating: starRating
    };

    // if no API key, send admin credentials in body as fallback
    if (!apiKey) {
      const adminUser = process.env.DB_LOGIN;
      const adminPass = process.env.DB_PASSWORD;
      if (!adminUser || !adminPass) return replySafe(interactionOrMessage, "❌ Server auth not configured (no API key and no DB_LOGIN/DB_PASSWORD). Contact an admin.", { ephemeral: true });
      body.admin_user = adminUser;
      body.admin_pass = adminPass;
    }

    // send request
    try {
      const axiosOpts = { timeout: 15_000 };
      if (apiKey) axiosOpts.headers = { 'X-API-KEY': apiKey };

      const res = await axios.post(url, body, axiosOpts);
      const data = res.data;

      if (!data || !data.success) {
        const err = data?.error ?? 'Unknown error from server';
        return replySafe(interactionOrMessage, `❌ Server error: ${err}`, { ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setTitle("Creature added")
        .setColor(0x2ECC71)
        .addFields(
          { name: "Player (CardWars ID)", value: String(cardwarsId), inline: true },
          { name: "Creature ID", value: String(creatureId), inline: true },
          { name: "UniqueID", value: String(data.unique_id ?? 'unknown'), inline: true },
          { name: "StarRating", value: String(data.starRating ?? starRating), inline: true },
          { name: "Inventory before", value: String(data.previous_inventory_count ?? 'unknown'), inline: true },
          { name: "Inventory now", value: String(data.new_inventory_count ?? 'unknown'), inline: true }
        )
        .setTimestamp()
        .setFooter({ text: `Added by ${interactionOrMessage.user?.tag ?? interactionOrMessage.author?.tag}` });

      return replySafe(interactionOrMessage, null, { embeds: [embed], ephemeral: true });

    } catch (err) {
      console.error('addcreature request failed:', err?.response?.data ?? err?.message ?? err);
      const message = err?.response?.data?.error ?? err?.message ?? 'Request failed';
      return replySafe(interactionOrMessage, `❌ Request failed: ${message}`, { ephemeral: true });
    }
  }
};
