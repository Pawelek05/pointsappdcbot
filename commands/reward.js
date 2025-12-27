// commands/reward.js
import PlayFab from 'playfab-sdk';
import axios from 'axios';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { replySafe, isInteraction, getStringOption, getIntegerOption } from '../utils/commandHelpers.js';
import isMod from '../utils/isMod.js';
import Reward from '../models/Reward.js';
import GuildConfig from '../models/GuildConfig.js';

const coinEmoji = '🪙';
const embedColor = 0xF1C40F; // gold
const alertColor = 0x2ECC71; // green
const manualColor = 0xE67E22; // orange

function normalizeBaseUrl(endpointBase) {
  if (!endpointBase) return null;
  try {
    const u = new URL(endpointBase);
    return u.origin;
  } catch (e) {
    let s = String(endpointBase).trim();
    s = s.replace(/\/+$/, '');
    s = s.replace(/\/api(\/.*)?$/i, '');
    return s;
  }
}

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
    { name: "list", description: "List rewards (mods only)", type: 1 },
    { name: "channel", description: "Set rewards alert channel (mods only)", type: 1, options: [{ name: "channel", description: "Channel to post reward alerts", type: 7, required: true }] },
    { name: "alerts", description: "Toggle reward alerts (mods only)", type: 1 }
  ],
  async execute(interactionOrMessage, args = []) {
    const isInt = isInteraction(interactionOrMessage);
    const sub = isInt ? ( (() => { try { return interactionOrMessage.options.getSubcommand(false); } catch(e){ return null; } })() ) : args[0];
    const guildId = interactionOrMessage.guild?.id;
    const userId = interactionOrMessage.user?.id ?? interactionOrMessage.author?.id;

    // set PlayFab secret
    PlayFab.settings.developerSecretKey = process.env.PLAYFAB_SECRET;

    // --- CLAIM (public) ---
    if (!sub || sub === "claim") {
      const rewards = await Reward.find({ guildId }).sort({ price: 1 }).lean();
      if (!rewards.length) return replySafe(interactionOrMessage, "❌ No rewards configured on this server.", { ephemeral: true });

      // build description with numbered items (only name + price)
      let desc = `Choose a reward by pressing the numbered button below. Price is shown with ${coinEmoji}.\n\n`;
      for (let i = 0; i < rewards.length; i++) {
        const r = rewards[i];
        const number = i + 1;
        const lineEmoji = r.emoji ? `${r.emoji} ` : '';
        desc += `**${number}.** ${lineEmoji}${r.name}\nPrice: ${coinEmoji}${r.price}\n\n`;
      }

      const embed = new EmbedBuilder()
        .setTitle("Available rewards")
        .setColor(embedColor)
        .setDescription(desc.trim());

      // build numbered buttons (numbers only)
      const rows = [];
      for (let i = 0; i < rewards.length; i += 5) {
        const row = new ActionRowBuilder();
        const slice = rewards.slice(i, i + 5);
        for (let j = 0; j < slice.length; j++) {
          const idx = i + j;
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`reward_claim::${guildId}::${idx}`)
              .setLabel(`${idx + 1}`)
              .setStyle(ButtonStyle.Primary)
          );
        }
        rows.push(row);
      }

      await replySafe(interactionOrMessage, null, { embeds: [embed], components: rows });

      // try to get reply message to collect components
      let message = null;
      if (isInt) {
        try { message = await interactionOrMessage.fetchReply(); } catch {}
      }
      const collectorSource = message ?? interactionOrMessage;
      const collector = collectorSource.createMessageComponentCollector ? collectorSource.createMessageComponentCollector({ time: 5 * 60 * 1000 }) : null;
      if (!collector) return;

      collector.on('collect', async (btnInt) => {
        await btnInt.deferReply({ ephemeral: true });

        // parse index and refresh rewards (to avoid stale indexes)
        const parts = btnInt.customId.split("::");
        if (parts.length < 3) return btnInt.editReply({ content: "❌ Invalid button data." });
        const idx = parseInt(parts[2], 10);
        if (Number.isNaN(idx)) return btnInt.editReply({ content: "❌ Invalid selection." });

        const rewardsRefreshed = await Reward.find({ guildId }).sort({ price: 1 }).lean();
        if (!rewardsRefreshed || idx < 0 || idx >= rewardsRefreshed.length) {
          return btnInt.editReply({ content: "❌ The selected reward is no longer available. Please try again." });
        }
        const reward = rewardsRefreshed[idx];

        await btnInt.editReply({ content: "✅ Reward selected. I will DM you with next steps." });

        // DM flow
        try {
          const dmChannel = await btnInt.user.createDM();
          await dmChannel.send(`You selected **${reward.name}** (Price: ${coinEmoji}${reward.price}).\nPlease reply in this DM with your **PlayFab ID**:`);

          const filter = m => m.author.id === btnInt.user.id && m.channelId === dmChannel.id;
          const collected = await dmChannel.awaitMessages({ filter, max: 1, time: 2 * 60 * 1000 });
          if (!collected || collected.size === 0) return dmChannel.send("⏲️ No PlayFab ID received — cancelled.");

          const pfMsg = collected.first();
          const playfabId = pfMsg.content.trim();

          // fetch PlayFab data
          let dataResult;
          try { dataResult = await pfGetUserData(playfabId); } catch (err) {
            return dmChannel.send(`❌ Error fetching PlayFab data: ${err.errorMessage ?? JSON.stringify(err)}`);
          }

          const pdata = dataResult?.data?.Data ?? {};
          const moneyStr = pdata.Money?.Value ?? "0";
          const money = Number(moneyStr);
          if (Number.isNaN(money)) return dmChannel.send("❌ Invalid Money value in PlayFab.");
          if (money < reward.price) return dmChannel.send(`❌ You have ${coinEmoji}${money} Money — need ${coinEmoji}${reward.price} to claim this reward.`);

          // CardWars ID ask
          await dmChannel.send("Please reply in this DM with your **CardWars ID**:");
          const collected2 = await dmChannel.awaitMessages({ filter, max: 1, time: 2 * 60 * 1000 });
          if (!collected2 || collected2.size === 0) return dmChannel.send("⏲️ No CardWars ID received — cancelled.");
          const cwMsg = collected2.first();
          const cardwarsId = cwMsg.content.trim();

          // Deduct money first
          const oldMoney = money;
          const newMoney = oldMoney - reward.price;
          try {
            await pfUpdateUserData(playfabId, { Money: String(newMoney) });
          } catch (err) {
            console.error("PlayFab deduct failed:", err);
            return dmChannel.send(`❌ Failed to deduct Money in PlayFab: ${err.errorMessage ?? JSON.stringify(err)}`);
          }

          // detect gems-type
          const rid = String(reward.rewardId ?? '').toLowerCase();
          const isGems =
            rid.includes('gems') ||
            rid.includes('freehardcurrency') ||
            rid.includes('paidhardcurrency') ||
            rid.includes('hardcurrency');

          // detect creature/rainbow requirement
          const isCreatureOrRainbow =
            rid.includes('creature') ||
            rid.includes('rainbow');

          if (isGems) {
            // call PythonAnywhere (normalized)
            const endpointRaw = process.env.PYAN_ENDPOINT;
            if (!endpointRaw) {
              // refund
              try { await pfUpdateUserData(playfabId, { Money: String(oldMoney) }); } catch {}
              return dmChannel.send("❌ Server endpoint not configured (PYAN_ENDPOINT). Contact an admin.");
            }

            const base = normalizeBaseUrl(endpointRaw);
            const grantUrl = base + '/api/grant_reward';
            const apiKey = process.env.PYAN_API_KEY;
            const adminUser = process.env.DB_LOGIN;
            const adminPass = process.env.DB_PASSWORD;
            let axiosOpts = { timeout: 10_000, headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'X-API-KEY': apiKey } : {}) } };

            // DEBUG
            try {
              console.log('[GRANT] will POST to:', grantUrl);
              console.log('[GRANT] payload:', { cardwars_id: cardwarsId, reward_type: "Gems", amount: reward.amount ?? reward.price, admin_user: apiKey ? undefined : adminUser ? '***' : undefined });
            } catch (e) {}

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
              grantResp = await axios.post(grantUrl, body, axiosOpts);
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

            // success embed to user
            const successEmbed = new EmbedBuilder()
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

            await dmChannel.send({ embeds: [successEmbed] });

            // try to alert channel about success (if configured)
            try {
              const cfg = await GuildConfig.findOne({ guildId });
              if (cfg?.rewardAlerts && cfg?.rewardChannelId) {
                const guildToUse = btnInt.guild ?? (await btnInt.client.guilds.fetch(guildId).catch(()=>null));
                if (guildToUse) {
                  const channel = await guildToUse.channels.fetch(cfg.rewardChannelId).catch(()=>null);
                  if (channel && channel.isTextBased && channel.send) {
                    const alertEmbed = new EmbedBuilder()
                      .setTitle("Reward Payout")
                      .setColor(alertColor)
                      .setDescription(`A reward was just granted automatically.`)
                      .addFields(
                        { name: "Discord user", value: `${btnInt.user.tag} (${btnInt.user.id})`, inline: true },
                        { name: "PlayFab ID", value: `${playfabId}`, inline: true },
                        { name: "CardWars ID", value: `${cardwarsId}`, inline: true },
                        { name: "Reward", value: `${reward.name} (${reward.rewardId})`, inline: true },
                        { name: "Amount", value: `**${reward.amount ?? reward.price}**`, inline: true },
                        { name: "Price (deducted)", value: `${coinEmoji}${reward.price}`, inline: true },
                        { name: "Previous Money", value: `${coinEmoji}${oldMoney}`, inline: true },
                        { name: "New Money", value: `${coinEmoji}${newMoney}`, inline: true }
                      )
                      .setTimestamp()
                      .setFooter({ text: `Claimed by ${btnInt.user.tag}` });
                    await channel.send({ embeds: [alertEmbed] }).catch(err => console.error("Failed to send reward alert:", err));
                  }
                }
              }
            } catch (err) {
              console.error("Alert sending error:", err);
            }

            try { await btnInt.editReply({ content: `✅ Done — check your DMs for details.`, ephemeral: true }); } catch {}
            return;
          } else {
            // non-gems flow: money already deducted, post manual alert and react with ✅ for admins
            try {
              const cfg = await GuildConfig.findOne({ guildId });
              if (!cfg?.rewardChannelId || !cfg?.rewardAlerts) {
                // inform user that admins not notified automatically
                await dmChannel.send("✅ Your Money has been deducted. Administrators were not notified automatically (no channel configured). Please contact an admin to grant the reward.");
                return;
              }

              const guildToUse = btnInt.guild ?? (await btnInt.client.guilds.fetch(guildId).catch(()=>null));
              if (!guildToUse) {
                // fallback: inform user
                await dmChannel.send("✅ Your Money has been deducted. Administrators will need to grant your reward manually. (Could not fetch guild to send alert).");
                return;
              }

              const channel = await guildToUse.channels.fetch(cfg.rewardChannelId).catch(()=>null);
              if (!channel || !channel.isTextBased) {
                await dmChannel.send("✅ Your Money has been deducted. Administrators could not be notified (invalid alert channel). Contact an admin.");
                return;
              }

              // if reward id contains creature or rainbow, ask the user what they want (loop until valid)
              let whatHeWants = null;
              if (isCreatureOrRainbow) {
                const amount = Number(reward.amount ?? reward.price) || 1;
                const maxWords = amount * 2;
                const question = amount > 1 ? "What creatures do you want? (max " + maxWords + " words)" : "What creature do you want? (max " + maxWords + " words)";
                // loop until valid or timeout per attempt
                while (true) {
                  await dmChannel.send(question);
                  const replyCol = await dmChannel.awaitMessages({ filter, max: 1, time: 2 * 60 * 1000 });
                  if (!replyCol || replyCol.size === 0) {
                    await dmChannel.send("⏲️ No answer received — cancelled.");
                    // refund to be safe because player didn't specify what they want
                    try { await pfUpdateUserData(playfabId, { Money: String(oldMoney) }); } catch (e) { console.error('Refund failed on timeout after creature prompt', e); }
                    return;
                  }
                  const reply = replyCol.first().content.trim();
                  const words = reply.split(/\s+/).filter(Boolean);
                  if (words.length === 0) {
                    await dmChannel.send(`❌ Invalid answer. Please provide up to ${maxWords} words describing the creature(s). Try again.`);
                    continue;
                  }
                  if (words.length > maxWords) {
                    await dmChannel.send(`❌ Too many words. You may provide up to ${maxWords} words but you provided ${words.length}. Try again.`);
                    continue;
                  }
                  // accepted
                  whatHeWants = reply;
                  break;
                }
              }

              const manualEmbed = new EmbedBuilder()
                .setTitle("Manual Reward Required")
                .setColor(manualColor)
                .setDescription("This reward requires manual granting by an administrator. React with ✅ when you've granted it.")
                .addFields(
                  { name: "Discord user", value: `${btnInt.user.tag} (${btnInt.user.id})`, inline: true },
                  { name: "PlayFab ID", value: `${playfabId}`, inline: true },
                  { name: "CardWars ID", value: `${cardwarsId}`, inline: true },
                  { name: "Reward", value: `${reward.name} (${reward.rewardId})`, inline: true },
                  { name: "Amount", value: `**${reward.amount ?? reward.price}**`, inline: true },
                  { name: "Price (deducted)", value: `${coinEmoji}${reward.price}`, inline: true },
                  { name: "Previous Money", value: `${coinEmoji}${oldMoney}`, inline: true },
                  { name: "New Money", value: `${coinEmoji}${newMoney}`, inline: true },
                  { name: "GuildId", value: `${guildId}`, inline: true }
                )
                .setTimestamp()
                .setFooter({ text: "React with ✅ when you manually grant this reward" });

              if (whatHeWants) {
                manualEmbed.addFields({ name: "What he wants:", value: String(whatHeWants) });
              } else {
                manualEmbed.addFields({ name: "What he wants:", value: "—" });
              }

              const sent = await channel.send({ embeds: [manualEmbed] });
              try { await sent.react('✅'); } catch (e) { console.error('React failed', e); }

              await dmChannel.send("✅ Your Money has been deducted. Administrators have been notified and will grant your reward manually. You will receive a DM when it is granted.");
              try { await btnInt.editReply({ content: `✅ Done — administrators were notified.`, ephemeral: true }); } catch {}
              return;
            } catch (err) {
              console.error("Manual reward alert failed:", err);
              try {
                await pfUpdateUserData(playfabId, { Money: String(oldMoney) });
                return dmChannel.send("❌ Failed to notify administrators about manual reward. Your money has been refunded. Contact admins.");
              } catch (refundErr) {
                console.error("Refund failed:", refundErr);
                return dmChannel.send("‼️ Failed to notify administrators and refund money — contact admins immediately.");
              }
            }
          }

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

    // --- CHANNEL (mods only) ---
    if (sub === "channel") {
      if (!isInt) return replySafe(interactionOrMessage, "❌ Use the slash command to set the channel.", { ephemeral: true });
      const isModerator = await isMod(userId, guildId);
      if (!isModerator) return replySafe(interactionOrMessage, "❌ Only moderators can set the reward channel.", { ephemeral: true });

      const channelOption = interactionOrMessage.options.getChannel("channel");
      if (!channelOption) return replySafe(interactionOrMessage, "❌ Channel not provided or invalid.", { ephemeral: true });

      try {
        await GuildConfig.findOneAndUpdate(
          { guildId },
          { $set: { rewardChannelId: channelOption.id, rewardAlerts: true } },
          { upsert: true }
        );
        return replySafe(interactionOrMessage, `✅ Reward alerts channel set to <#${channelOption.id}> and alerts enabled.`, { ephemeral: true });
      } catch (err) {
        console.error("Error setting reward channel:", err);
        return replySafe(interactionOrMessage, `❌ Failed to set channel: ${err.message}`, { ephemeral: true });
      }
    }

    // --- ALERTS toggle (mods only) ---
    if (sub === "alerts") {
      const isModerator = await isMod(userId, guildId);
      if (!isModerator) return replySafe(interactionOrMessage, "❌ Only moderators can toggle alerts.", { ephemeral: true });

      try {
        const cfg = await GuildConfig.findOne({ guildId });
        if (!cfg) {
          const newCfg = new GuildConfig({ guildId, rewardAlerts: false });
          await newCfg.save();
          return replySafe(interactionOrMessage, `✅ Reward alerts toggled: **disabled**. Use /reward channel to set channel and enable.`, { ephemeral: true });
        } else {
          cfg.rewardAlerts = !cfg.rewardAlerts;
          await cfg.save();
          return replySafe(interactionOrMessage, `✅ Reward alerts toggled: **${cfg.rewardAlerts ? 'enabled' : 'disabled'}**.`, { ephemeral: true });
        }
      } catch (err) {
        console.error("Error toggling reward alerts:", err);
        return replySafe(interactionOrMessage, `❌ Failed to toggle alerts: ${err.message}`, { ephemeral: true });
      }
    }

    // --- ADD / REMOVE / LIST (mods only) ---
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

    if (sub === "remove") {
      const isModerator = await isMod(userId, guildId);
      if (!isModerator) return replySafe(interactionOrMessage, "❌ Only moderators can remove rewards.", { ephemeral: true });
      const rewardId = getStringOption(interactionOrMessage, "id", args, 0);
      if (!rewardId) return replySafe(interactionOrMessage, "❌ Provide reward ID.", { ephemeral: true });
      const found = await Reward.findOneAndDelete({ guildId, rewardId });
      if (!found) return replySafe(interactionOrMessage, `❌ Reward \`${rewardId}\` not found.`, { ephemeral: true });
      return replySafe(interactionOrMessage, `✅ Removed reward \`${rewardId}\`.`, { ephemeral: true });
    }

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

    return replySafe(interactionOrMessage, "Use subcommands: claim / add / remove / list / channel / alerts", { ephemeral: true });
  }
};
