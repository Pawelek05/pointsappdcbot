// commands/reward.js
import PlayFab from 'playfab-sdk';
import axios from 'axios';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { replySafe, isInteraction, getStringOption, getIntegerOption } from '../utils/commandHelpers.js';
import isMod from '../utils/isMod.js';
import Reward from '../models/Reward.js';

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
        { name: "description", description: "Description", type: 3, required: true },
        { name: "price", description: "Price in Money", type: 10, required: true },
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
        .setDescription("Click the button for the reward you want. I will DM you and guide through the claim process.");

      for (const r of rewards) {
        embed.addFields({ name: `${r.emoji ?? ""} ${r.name} — ${r.price} Money`, value: `ID: \`${r.rewardId}\`\n${r.description}` });
      }

      const rows = [];
      for (let i = 0; i < rewards.length; i += 5) {
        const slice = rewards.slice(i, i + 5);
        const row = new ActionRowBuilder();
        slice.forEach(r => {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`reward_claim::${guildId}::${r.rewardId}`)
              .setLabel(`${r.name} (${r.price})`)
              .setStyle(ButtonStyle.Primary)
          );
        });
        rows.push(row);
      }

      const sent = await replySafe(interactionOrMessage, null, { embeds: [embed], components: rows });
      // replySafe for interactions may return a Promise for the interaction reply; assume it returns a Message-like object in your environment
      const message = sent;

      const collector = message.createMessageComponentCollector ? message.createMessageComponentCollector({ time: 5 * 60 * 1000 }) : null;
      if (!collector) return; // fallback: not supported in this environment

      collector.on('collect', async (btnInt) => {
        await btnInt.deferReply({ ephemeral: true });
        const [, guildFromId, rewardId] = btnInt.customId.split("::");
        const reward = await Reward.findOne({ guildId: guildFromId, rewardId }).lean();
        if (!reward) return btnInt.editReply({ content: "❌ Chosen reward no longer exists." });

        await btnInt.editReply({ content: "✅ Reward selected. I will DM you with next steps." });

        // DM flow
        try {
          const dm = await btnInt.user.send(`You selected **${reward.name}** (${reward.price} Money).\nPlease reply with your PlayFab ID (PlayFabId):`);
          const filter = m => m.author.id === btnInt.user.id;
          const collected = await dm.channel.awaitMessages({ filter, max: 1, time: 2 * 60 * 1000 });
          const pfMsg = collected.first();
          if (!pfMsg) return dm.channel.send("⏲️ No PlayFab ID received — cancelled.");

          const playfabId = pfMsg.content.trim();

          // fetch PlayFab user data
          const getData = () => new Promise((resolve, reject) => {
            PlayFab.PlayFabServer.GetUserData({ PlayFabId: playfabId }, (err, res) => err ? reject(err) : resolve(res));
          });

          let dataResult;
          try { dataResult = await getData(); } catch (err) {
            return dm.channel.send(`❌ Error fetching PlayFab data: ${err.errorMessage ?? JSON.stringify(err)}`);
          }

          const pdata = dataResult?.data?.Data ?? {};
          const moneyStr = pdata.Money?.Value ?? "0";
          const money = Number(moneyStr);
          if (Number.isNaN(money)) return dm.channel.send("❌ Invalid Money value in PlayFab.");
          if (money < reward.price) return dm.channel.send(`❌ You have ${money} Money — need ${reward.price} Money to claim this reward.`);

          // ask for CardWars ID
          await dm.channel.send("Please provide your CardWars ID:");
          const collected2 = await dm.channel.awaitMessages({ filter, max: 1, time: 2 * 60 * 1000 });
          const cwMsg = collected2.first();
          if (!cwMsg) return dm.channel.send("⏲️ No CardWars ID received — cancelled.");
          const cardwarsId = cwMsg.content.trim();

          // If rewardId === "Gems" => call external endpoint on PythonAnywhere
          if (reward.rewardId === "Gems") {
            const endpoint = process.env.PYAN_ENDPOINT;
            if (!endpoint) return dm.channel.send("❌ Server endpoint not configured (PYAN_ENDPOINT). Contact an admin.");

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
                amount: reward.price // amount mapping - adjust if you want different ratio
              };
              if (!apiKey) {
                // admin creds fallback (will be used only if PYAN_API_KEY not set)
                if (!adminUser || !adminPass) {
                  return dm.channel.send("❌ Server auth not configured. Contact an admin.");
                }
                body.admin_user = adminUser;
                body.admin_pass = adminPass;
              }

              grantResp = await axios.post(endpoint, body, axiosOpts);
            } catch (err) {
              const msg = err.response?.data?.error ?? err.message;
              return dm.channel.send(`❌ Error calling grant endpoint: ${msg}`);
            }

            if (!grantResp.data || !grantResp.data.success) {
              return dm.channel.send(`❌ Grant endpoint returned an error: ${grantResp.data?.error ?? 'unknown'}`);
            }
          } else {
            // For other reward types you may extend logic here (e.g. set flags, give skin, etc.)
            await dm.channel.send("⚠️ This reward type is not implemented on the game backend. Contact admins.");
            return;
          }

          // Deduct Money in PlayFab (update Data.Money)
          const newMoney = money - reward.price;
          const updateData = () => new Promise((resolve, reject) => {
            PlayFab.PlayFabServer.UpdateUserData({
              PlayFabId: playfabId,
              Data: { Money: String(newMoney) }
            }, (err, res) => err ? reject(err) : resolve(res));
          });

          try { await updateData(); } catch (err) {
            return dm.channel.send(`⚠️ The reward was granted but I failed to update PlayFab Money: ${err.errorMessage ?? JSON.stringify(err)}`);
          }

          await dm.channel.send(`✅ Success — reward **${reward.name}** granted. Your new Money: ${newMoney}.`);
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
        message.edit({ components: disabledRows }).catch(()=>{});
      });

      return;
    }

    // --- ADD (mods) ---
    if (sub === "add") {
      const isModerator = await isMod(userId, guildId);
      if (!isModerator) return replySafe(interactionOrMessage, "❌ Only moderators can add rewards.", { ephemeral: true });

      const rewardId = getStringOption(interactionOrMessage, "id", args, 0);
      const name = getStringOption(interactionOrMessage, "name", args, 1);
      const description = getStringOption(interactionOrMessage, "description", args, 2);
      const priceVal = getIntegerOption(interactionOrMessage, "price", args, 3);
      const price = priceVal !== null ? Number(priceVal) : NaN;
      const emoji = getStringOption(interactionOrMessage, "emoji", args, 4) || null;

      if (!rewardId || !name || Number.isNaN(price)) return replySafe(interactionOrMessage, "❌ Invalid arguments.", { ephemeral: true });

      try {
        const exists = await Reward.findOne({ guildId, rewardId });
        if (exists) return replySafe(interactionOrMessage, `❌ Reward with ID \`${rewardId}\` already exists.`, { ephemeral: true });
        const r = new Reward({ guildId, rewardId, name, description, price, emoji });
        await r.save();
        return replySafe(interactionOrMessage, `✅ Added reward **${name}** (${price} Money).`, { ephemeral: true });
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
      const embed = new EmbedBuilder().setTitle("Rewards list");
      embed.addFields(rewards.map(r => ({ name: `${r.rewardId} — ${r.name} (${r.price})`, value: r.description || "No description" })));
      return replySafe(interactionOrMessage, null, { embeds: [embed], ephemeral: true });
    }

    return replySafe(interactionOrMessage, "Use subcommands: claim / add / remove / list", { ephemeral: true });
  }
};
