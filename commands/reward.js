// commands/reward.js
import PlayFab from 'playfab-sdk';
import axios from 'axios';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { replySafe, isInteraction, getStringOption, getIntegerOption } from '../utils/commandHelpers.js';
import isMod from '../utils/isMod.js';
import Reward from '../models/Reward.js';

const coinEmoji = '🪙'; // you can change to '💰' if device doesn't support
const embedColor = 0xF1C40F; // gold

function pfGetUserData(playfabId) {
  return new Promise((resolve, reject) => {
    PlayFab.PlayFabServer.GetUserData({ PlayFabId: playfabId }, (err, res) => err ? reject(err) : resolve(res));
  });
}
function pfUpdateUserData(playfabId, dataObj) {
  return new Promise((resolve, reject) => {
    PlayFab.PlayFabServer.UpdateUserData({ PlayFabId: playfabId, Data: dataObj }, (err, res) => err ? reject(err) : resolve(res));
  });
}

export default {
  name: "reward",
  description: "Manage and claim rewards",
  options: [
    { name: "claim", description: "Show rewards and allow to claim (public)", type: 1 },
    {
      name: "add",
      description: "Add a reward (mods only)",
      type: 1,
      options: [
        { name: "id", description: "Reward ID (e.g. Gems)", type: 3, required: true },
        { name: "name", description: "Display name", type: 3, required: true },
        { name: "price", description: "Price in Money (coins)", type: 10, required: true },
        { name: "amount", description: "Amount to grant (for Gems)", type: 10, required: true },
        { name: "emoji", description: "Emoji (optional)", type: 3, required: false }
      ]
    },
    { name: "remove", description: "Remove reward by id (mods only)", type: 1, options: [{ name: "id", description: "Reward ID", type: 3, required: true }] },
    { name: "list", description: "List rewards (mods only)", type: 1 }
  ],
  async execute(interactionOrMessage, args = []) {
    const isInt = isInteraction(interactionOrMessage);
    const sub = isInt ? interactionOrMessage.options.getSubcommand(false) : args[0];
    const guildId = interactionOrMessage.guild?.id;
    const userId = interactionOrMessage.user?.id ?? interactionOrMessage.author?.id;

    // PlayFab secret from env
    PlayFab.settings.developerSecretKey = process.env.PLAYFAB_SECRET;

    // --- CLAIM ---
    if (!sub || sub === "claim") {
      const rewards = await Reward.find({ guildId }).sort({ price: 1 }).lean();
      if (!rewards.length) return replySafe(interactionOrMessage, "❌ No rewards configured on this server.", { ephemeral: true });

      const embed = new EmbedBuilder()
        .setTitle("Available rewards")
        .setColor(embedColor)
        .setDescription(`Click a button to choose a reward. Price shown in ${coinEmoji} (Money).`);

      // nicer listing: add each reward as a field
      for (const r of rewards) {
        const amt = r.amount ?? r.price;
        embed.addFields({
          name: `${r.emoji ?? ''} ${r.name} — ${coinEmoji}${r.price}`,
          value: `ID: \`${r.rewardId}\` • Grants: **${amt}**`,
        });
      }

      // build buttons (max 5 per row)
      const rows = [];
      for (let i = 0; i < rewards.length; i += 5) {
        const slice = rewards.slice(i, i + 5);
        const row = new ActionRowBuilder();
        slice.forEach(r => {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`reward_claim::${guildId}::${r.rewardId}`)
              .setLabel(`${r.name} — ${coinEmoji}${r.price}`)
              .setStyle(ButtonStyle.Primary)
          );
        });
        rows.push(row);
      }

      // send reply with components (replySafe now supports components)
      await replySafe(interactionOrMessage, null, { embeds: [embed], components: rows });

      // get message object to create collector (interaction.fetchReply for slash)
      let message;
      if (isInt) {
        try {
          message = await interactionOrMessage.fetchReply();
        } catch {
          // fallback: try to find last message in channel (best-effort)
          message = null;
        }
      } else {
        // message-based reply returned by replySafe
        // replySafe returns the promise from message.reply — hard to unify; try to fetch the last message in channel
        message = null;
      }

      // if we couldn't obtain message object (some libs), try to collect via interaction.createMessageComponentCollector
      const createCollectorFrom = message ?? interactionOrMessage;
      const collector = createCollectorFrom.createMessageComponentCollector ? createCollectorFrom.createMessageComponentCollector({ time: 5 * 60 * 1000 }) : null;
      if (!collector) {
        // If no collector support, inform user to click the buttons (some envs lack collectors)
        return;
      }

      collector.on('collect', async (btnInt) => {
        await btnInt.deferReply({ ephemeral: true });
        const [, guildFromId, rewardId] = btnInt.customId.split("::");
        const reward = await Reward.findOne({ guildId: guildFromId, rewardId }).lean();
        if (!reward) return btnInt.editReply({ content: "❌ Chosen reward no longer exists." });

        await btnInt.editReply({ content: "✅ Reward selected. I will DM you with next steps." });

        // DM flow
        try {
          const dm = await btnInt.user.send(`You selected **${reward.name}** (${coinEmoji}${reward.price}).\nPlease reply with your PlayFab ID (PlayFabId):`);
          const filter = m => m.author.id === btnInt.user.id;
          const collected = await dm.channel.awaitMessages({ filter, max: 1, time: 2 * 60 * 1000 });
          const pfMsg = collected.first();
          if (!pfMsg) return dm.channel.send("⏲️ No PlayFab ID received — cancelled.");

          const playfabId = pfMsg.content.trim();

          // fetch PlayFab user data
          let dataResult;
          try { dataResult = await pfGetUserData(playfabId); } catch (err) {
            return dm.channel.send(`❌ Error fetching PlayFab data: ${err.errorMessage ?? JSON.stringify(err)}`);
          }

          const pdata = dataResult?.data?.Data ?? {};
          const moneyStr = pdata.Money?.Value ?? "0";
          const money = Number(moneyStr);
          if (Number.isNaN(money)) return dm.channel.send("❌ Invalid Money value in PlayFab.");
          if (money < reward.price) return dm.channel.send(`❌ You have ${coinEmoji}${money} Money — need ${coinEmoji}${reward.price} to claim this reward.`);

          // ask for CardWars ID
          await dm.channel.send("Please provide your CardWars ID:");
          const collected2 = await dm.channel.awaitMessages({ filter, max: 1, time: 2 * 60 * 1000 });
          const cwMsg = collected2.first();
          if (!cwMsg) return dm.channel.send("⏲️ No CardWars ID received — cancelled.");
          const cardwarsId = cwMsg.content.trim();

          // TRANSACTION: Deduct PlayFab money FIRST, then call PA. Rollback if PA fails.
          const oldMoney = money;
          const newMoney = oldMoney - reward.price;

          try {
            await pfUpdateUserData(playfabId, { Money: String(newMoney) });
          } catch (err) {
            console.error("PlayFab deduct failed:", err);
            return dm.channel.send(`❌ Failed to deduct Money in PlayFab: ${err.errorMessage ?? JSON.stringify(err)}`);
          }

          // Now call PythonAnywhere to grant (for Gems)
          if (reward.rewardId === "Gems") {
            const endpoint = process.env.PYAN_ENDPOINT;
            if (!endpoint) {
              // attempt refund
              try { await pfUpdateUserData(playfabId, { Money: String(oldMoney) }); } catch {}
              return dm.channel.send("❌ Server endpoint not configured (PYAN_ENDPOINT). Contact an admin.");
            }

            const apiKey = process.env.PYAN_API_KEY; // preferred
            const adminUser = process.env.DB_LOGIN;  // Railway admin login
            const adminPass = process.env.DB_PASSWORD;
            let axiosOpts = { timeout: 10_000 };
            if (apiKey) axiosOpts.headers = { 'X-API-KEY': apiKey };

            let grantResp;
            try {
              const body = {
                cardwars_id: cardwarsId,
                reward_type: "Gems",
                amount: reward.amount ?? reward.price
              };
              if (!apiKey) {
                if (!adminUser || !adminPass) {
                  // refund
                  try { await pfUpdateUserData(playfabId, { Money: String(oldMoney) }); } catch {}
                  return dm.channel.send("❌ Server auth not configured. Contact an admin.");
                }
                body.admin_user = adminUser;
                body.admin_pass = adminPass;
              }
              grantResp = await axios.post(endpoint, body, axiosOpts);
            } catch (err) {
              const errMsg = err.response?.data?.error ?? err.message ?? String(err);
              console.error("Grant call failed:", errMsg);
              // attempt refund
              try {
                await pfUpdateUserData(playfabId, { Money: String(oldMoney) });
                return dm.channel.send(`❌ Grant failed: ${errMsg}. Your Money has been refunded to ${coinEmoji}${oldMoney}.`);
              } catch (refundErr) {
                console.error("Refund failed after grant error:", refundErr);
                return dm.channel.send(`‼️ Grant failed: ${errMsg}. Refund attempt also failed — contact admins immediately.`);
              }
            }

            if (!grantResp.data || !grantResp.data.success) {
              const apiErr = grantResp.data?.error ?? 'unknown';
              // attempt refund
              try {
                await pfUpdateUserData(playfabId, { Money: String(oldMoney) });
                return dm.channel.send(`❌ Grant endpoint returned error: ${apiErr}. Your Money has been refunded to ${coinEmoji}${oldMoney}.`);
              } catch (refundErr) {
                console.error("Rollback failed after endpoint error:", refundErr);
                return dm.channel.send(`‼️ Grant endpoint error: ${apiErr}. Refund failed — contact admins.`);
              }
            }
          } else {
            // Extendable: other reward types handling
            // If not implemented, refund and tell user
            try { await pfUpdateUserData(playfabId, { Money: String(oldMoney) }); } catch {}
            return dm.channel.send("⚠️ This reward type is not implemented on the game backend. Contact admins.");
          }

          // success
          await dm.channel.send(`✅ Success — reward **${reward.name}** granted. Your new Money: ${coinEmoji}${newMoney}.`);
        } catch (err) {
          console.error("DM flow error:", err);
          try { await btnInt.user.send("❌ An error occurred during the claim process. Try again later."); } catch {}
        }
      });

      collector.on('end', () => {
        // disable buttons
        const disabledRows = rows.map(r => {
          r.components.forEach(c => c.setDisabled(true));
          return r;
        });
        // message may be null in some environments; best-effort edit
        if (message && message.edit) {
          message.edit({ components: disabledRows }).catch(()=>{});
        } else if (interactionOrMessage && interactionOrMessage.editReply) {
          interactionOrMessage.editReply({ components: disabledRows }).catch(()=>{});
        }
      });

      return;
    }

    // --- ADD (mods) ---
    if (sub === "add") {
      const isModerator = await isMod(userId, guildId);
      if (!isModerator) return replySafe(interactionOrMessage, "❌ Only moderators can add rewards.", { ephemeral: true });

      const rewardId = getStringOption(interactionOrMessage, "id", args, 0);
      const name = getStringOption(interactionOrMessage, "name", args, 1);
      const priceVal = getIntegerOption(interactionOrMessage, "price", args, 2);
      const amountVal = getIntegerOption(interactionOrMessage, "amount", args, 3);
      const price = priceVal !== null ? Number(priceVal) : NaN;
      const amount = amountVal !== null ? Number(amountVal) : NaN;
      const emoji = getStringOption(interactionOrMessage, "emoji", args, 4) || null;

      if (!rewardId || !name || Number.isNaN(price) || Number.isNaN(amount)) return replySafe(interactionOrMessage, "❌ Invalid arguments. Usage: id, name, price, amount", { ephemeral: true });

      try {
        const exists = await Reward.findOne({ guildId, rewardId });
        if (exists) return replySafe(interactionOrMessage, `❌ Reward with ID \`${rewardId}\` already exists.`, { ephemeral: true });
        const r = new Reward({ guildId, rewardId, name, price, amount, emoji });
        await r.save();
        return replySafe(interactionOrMessage, `✅ Added reward **${name}** — Grants **${amount}** for ${coinEmoji}${price}.`, { ephemeral: true });
      } catch (err) {
        console.error(err);
        return replySafe(interactionOrMessage, `❌ Error adding reward: ${err.message}`, { ephemeral: true });
      }
    }

    // --- REMOVE ---
    if (sub === "remove") {
      const isModerator = await isMod(userId, guildId);
      if (!isModerator) return replySafe(interactionOrMessage, "❌ Only moderators can remove rewards.", { ephemeral: true });
      const rewardId = getStringOption(interactionOrMessage, "id", args, 0);
      if (!rewardId) return replySafe(interactionOrMessage, "❌ Provide reward ID.", { ephemeral: true });
      const found = await Reward.findOneAndDelete({ guildId, rewardId });
      if (!found) return replySafe(interactionOrMessage, `❌ Reward \`${rewardId}\` not found.`, { ephemeral: true });
      return replySafe(interactionOrMessage, `✅ Removed reward \`${rewardId}\`.`, { ephemeral: true });
    }

    // --- LIST ---
    if (sub === "list") {
      const isModerator = await isMod(userId, guildId);
      if (!isModerator) return replySafe(interactionOrMessage, "❌ Only moderators can view rewards list.", { ephemeral: true });
      const rewards = await Reward.find({ guildId }).sort({ price: 1 }).lean();
      if (!rewards.length) return replySafe(interactionOrMessage, "❌ No rewards.", { ephemeral: true });
      const embed = new EmbedBuilder().setTitle("Rewards list").setColor(embedColor);
      embed.addFields(rewards.map(r => ({ name: `${r.rewardId} — ${r.name} (${coinEmoji}${r.price})`, value: `Grants: **${r.amount ?? r.price}**` })));
      return replySafe(interactionOrMessage, null, { embeds: [embed], ephemeral: true });
    }

    return replySafe(interactionOrMessage, "Use subcommands: claim / add / remove / list", { ephemeral: true });
  }
};
