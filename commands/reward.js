// commands/reward.js
import PlayFab from 'playfab-sdk';
import axios from 'axios';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { replySafe, isInteraction, getStringOption, getIntegerOption } from '../utils/commandHelpers.js';
import isMod from '../utils/isMod.js';
import Reward from '../models/Reward.js';

const coinEmoji = '🪙';
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

    // set PlayFab secret
    PlayFab.settings.developerSecretKey = process.env.PLAYFAB_SECRET;

    // --- CLAIM ---
    if (!sub || sub === "claim") {
      const rewards = await Reward.find({ guildId }).sort({ price: 1 }).lean();
      if (!rewards.length) return replySafe(interactionOrMessage, "❌ No rewards configured on this server.", { ephemeral: true });

      // build tidy description: each reward in its own block (name + price), no ID, no amount
      let desc = `Choose a reward by pressing the button below. Price is shown with ${coinEmoji}.\n\n`;
      for (const r of rewards) {
        const lineEmoji = r.emoji ? `${r.emoji} ` : '';
        desc += `${lineEmoji}**${r.name}**\nPrice: ${coinEmoji}${r.price}\n\n`;
      }

      const embed = new EmbedBuilder()
        .setTitle("Available rewards")
        .setColor(embedColor)
        .setDescription(desc.trim());

      // build buttons: label = name only (no coin emoji, no ID)
      const rows = [];
      for (let i = 0; i < rewards.length; i += 5) {
        const slice = rewards.slice(i, i + 5);
        const row = new ActionRowBuilder();
        for (const r of slice) {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`reward_claim::${guildId}::${r.rewardId}`)
              .setLabel(`${r.name}`)
              .setStyle(ButtonStyle.Primary)
          );
        }
        rows.push(row);
      }

      await replySafe(interactionOrMessage, null, { embeds: [embed], components: rows });

      // fetch message if possible, create collector
      let message = null;
      if (isInt) {
        try { message = await interactionOrMessage.fetchReply(); } catch {}
      }
      const collectorSource = message ?? interactionOrMessage;
      const collector = collectorSource.createMessageComponentCollector ? collectorSource.createMessageComponentCollector({ time: 5 * 60 * 1000 }) : null;
      if (!collector) return;

      collector.on('collect', async (btnInt) => {
        await btnInt.deferReply({ ephemeral: true });

        const [, guildFromId, rewardId] = btnInt.customId.split("::");
        const reward = await Reward.findOne({ guildId: guildFromId, rewardId }).lean();
        if (!reward) return btnInt.editReply({ content: "❌ Chosen reward no longer exists." });

        await btnInt.editReply({ content: "✅ Reward selected. I will DM you with next steps." });

        // DM collection - robust
        try {
          const dmChannel = await btnInt.user.createDM();
          await dmChannel.send(`You selected **${reward.name}** (Price: ${coinEmoji}${reward.price}).\nPlease reply in this DM with your **PlayFab ID**:`);

          const filter = m => m.author.id === btnInt.user.id && m.channelId === dmChannel.id;
          const collected = await dmChannel.awaitMessages({ filter, max: 1, time: 2 * 60 * 1000 });
          if (!collected || collected.size === 0) return dmChannel.send("⏲️ No PlayFab ID received — cancelled.");

          const pfMsg = collected.first();
          const playfabId = pfMsg.content.trim();

          // get playerdata
          let dataResult;
          try { dataResult = await pfGetUserData(playfabId); } catch (err) {
            return dmChannel.send(`❌ Error fetching PlayFab data: ${err.errorMessage ?? JSON.stringify(err)}`);
          }

          const pdata = dataResult?.data?.Data ?? {};
          const moneyStr = pdata.Money?.Value ?? "0";
          const money = Number(moneyStr);
          if (Number.isNaN(money)) return dmChannel.send("❌ Invalid Money value in PlayFab.");
          if (money < reward.price) return dmChannel.send(`❌ You have ${coinEmoji}${money} Money — need ${coinEmoji}${reward.price} to claim this reward.`);

          // ask for CardWars ID
          await dmChannel.send("Please reply in this DM with your **CardWars ID**:");
          const collected2 = await dmChannel.awaitMessages({ filter, max: 1, time: 2 * 60 * 1000 });
          if (!collected2 || collected2.size === 0) return dmChannel.send("⏲️ No CardWars ID received — cancelled.");
          const cwMsg = collected2.first();
          const cardwarsId = cwMsg.content.trim();

          // TRANS: deduct PlayFab money first
          const oldMoney = money;
          const newMoney = oldMoney - reward.price;
          try {
            await pfUpdateUserData(playfabId, { Money: String(newMoney) });
          } catch (err) {
            console.error("PlayFab deduct failed:", err);
            return dmChannel.send(`❌ Failed to deduct Money in PlayFab: ${err.errorMessage ?? JSON.stringify(err)}`);
          }

          // If reward id contains 'gems' -> call PythonAnywhere grant
          const isGems = /gems/i.test(String(reward.rewardId));
          if (isGems) {
            const endpoint = process.env.PYAN_ENDPOINT;
            if (!endpoint) {
              try { await pfUpdateUserData(playfabId, { Money: String(oldMoney) }); } catch {}
              return dmChannel.send("❌ Server endpoint not configured (PYAN_ENDPOINT). Contact an admin.");
            }

            const apiKey = process.env.PYAN_API_KEY;
            const adminUser = process.env.DB_LOGIN;
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
                  try { await pfUpdateUserData(playfabId, { Money: String(oldMoney) }); } catch {}
                  return dmChannel.send("❌ Server auth not configured. Contact an admin.");
                }
                body.admin_user = adminUser;
                body.admin_pass = adminPass;
              }
              grantResp = await axios.post(endpoint, body, axiosOpts);
            } catch (err) {
              const errMsg = err.response?.data?.error ?? err.message ?? String(err);
              console.error("Grant call failed:", errMsg);
              try {
                await pfUpdateUserData(playfabId, { Money: String(oldMoney) });
                return dmChannel.send(`❌ Grant failed: ${errMsg}. Your Money has been refunded to ${coinEmoji}${oldMoney}.`);
              } catch (refundErr) {
                console.error("Refund failed after grant error:", refundErr);
                return dmChannel.send(`‼️ Grant failed: ${errMsg}. Refund attempt also failed — contact admins immediately.`);
              }
            }

            if (!grantResp.data || !grantResp.data.success) {
              const apiErr = grantResp.data?.error ?? 'unknown';
              try {
                await pfUpdateUserData(playfabId, { Money: String(oldMoney) });
                return dmChannel.send(`❌ Grant endpoint returned error: ${apiErr}. Your Money has been refunded to ${coinEmoji}${oldMoney}.`);
              } catch (refundErr) {
                console.error("Rollback failed after endpoint error:", refundErr);
                return dmChannel.send(`‼️ Grant endpoint error: ${apiErr}. Refund failed — contact admins.`);
              }
            }
          } else {
            try { await pfUpdateUserData(playfabId, { Money: String(oldMoney) }); } catch {}
            return dmChannel.send("⚠️ This reward type is not implemented on the game backend. Contact admins.");
          }

          // success: prepare final embed summarizing details
          const resultEmbed = new EmbedBuilder()
            .setTitle("Reward claimed")
            .setColor(embedColor)
            .addFields(
              { name: "Discord user", value: `${btnInt.user.tag} (${btnInt.user.id})`, inline: true },
              { name: "PlayFab ID", value: `${playfabId}`, inline: true },
              { name: "CardWars ID", value: `${cardwarsId}`, inline: true },
              { name: "Reward", value: `${reward.name}`, inline: true },
              { name: "Amount granted", value: `**${reward.amount ?? reward.price}**`, inline: true },
              { name: "Price deducted", value: `${coinEmoji}${reward.price}`, inline: true },
              { name: "Previous Money", value: `${coinEmoji}${oldMoney}`, inline: true },
              { name: "New Money", value: `${coinEmoji}${newMoney}`, inline: true }
            )
            .setTimestamp()
            .setFooter({ text: "Keep this as proof of the transaction" });

          await dmChannel.send({ embeds: [resultEmbed] });

          try {
            await btnInt.editReply({ content: `✅ Done — check your DMs for details.`, ephemeral: true });
          } catch {}
        } catch (err) {
          console.error("DM flow error:", err);
          try { await btnInt.user.send("❌ An error occurred during the claim process. Try again later."); } catch {}
        }
      });

      collector.on('end', () => {
        const disabledRows = rows.map(r => {
          r.components.forEach(c => c.setDisabled(true));
          return r;
        });
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

      const embed = new EmbedBuilder()
        .setTitle("Rewards list")
        .setColor(embedColor)
        .setDescription(`ID • Reward name • Amount • Price (${coinEmoji} Money)`);

      for (const r of rewards) {
        embed.addFields({
          name: `ID: \`${r.rewardId}\` — ${r.name}`,
          value: `Amount: **${r.amount ?? r.price}** • Price: ${coinEmoji}${r.price}`,
        });
      }

      return replySafe(interactionOrMessage, null, { embeds: [embed], ephemeral: true });
    }

    return replySafe(interactionOrMessage, "Use subcommands: claim / add / remove / list", { ephemeral: true });
  }
};