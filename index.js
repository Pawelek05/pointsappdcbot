// index.js
import { Client, GatewayIntentBits, Partials, Collection, REST, Routes, EmbedBuilder } from 'discord.js';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import GuildConfig from './models/GuildConfig.js';
import PlayFab from 'playfab-sdk';
import ocrHandler from './events/messageCreate.ocr.js';
import isMod from './utils/isMod.js';

const config = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf-8'));

// --- PLAYFAB SERVER CONFIG ---
PlayFab.settings.titleId = "171DCA";
PlayFab.settings.developerSecretKey = process.env.PLAYFAB_SECRET;

// --- ENV CHECK ---
const { TOKEN, CLIENT_ID, MONGO_URI } = process.env;
if (!TOKEN || !CLIENT_ID || !MONGO_URI || !process.env.PLAYFAB_SECRET) {
  console.error("❌ Missing environment variables! Set TOKEN, CLIENT_ID, MONGO_URI, PLAYFAB_SECRET");
  process.exit(1);
}

// --- CLIENT: add reaction intents! ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,    // <- REQUIRED for reaction events in guild channels
    GatewayIntentBits.DirectMessageReactions    // <- REQUIRED for reaction events in DMs (if any)
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.Reaction
  ]
});
client.commands = new Collection();

// --- LOAD COMMANDS ---
const commandFiles = fs.readdirSync(path.join('./commands')).filter(f => f.endsWith('.js'));
for (const file of commandFiles) {
  const cmd = await import(`./commands/${file}`);
  client.commands.set(cmd.default.name, cmd.default);
}

// --- MONGODB CONNECTION ---
try {
  await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log("✅ MongoDB connected");
} catch (err) {
  console.error("❌ MongoDB connection failed:", err);
  process.exit(1);
}

// --- SLASH COMMANDS REGISTRATION ---
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const slashCommands = [];

  for (const cmd of client.commands.values()) {
    slashCommands.push({
      name: cmd.name,
      description: cmd.description || 'No description',
      options: cmd.options || []
    });
  }

  for (const guild of client.guilds.cache.values()) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(CLIENT_ID, guild.id),
        { body: slashCommands }
      );
      console.log(`✅ Registered slash commands for guild ${guild.id}`);
    } catch (e) {
      console.error("❌ Slash command registration error:", e);
    }
  }
});

// --- HELPERS ---
async function getPrefix(guildId) {
  const cfg = await GuildConfig.findOne({ guildId });
  return cfg?.prefix || config.defaultPrefix || '=';
}

async function hasPermission(userId, guildId, guildOwnerId) {
  if (userId === config.ownerId) return true; // bot owner
  if (userId === guildOwnerId) return true;   // guild owner

  const cfg = await GuildConfig.findOne({ guildId });
  return cfg?.mods.includes(userId) || false;
}

// --- MESSAGE COMMAND HANDLER (prefix) ---
client.on('messageCreate', async message => {
  try {
    if (message.author.bot || !message.guild) return;

    // call OCR handler (fire-and-forget)
    ocrHandler(message).catch(err => console.error('OCR error:', err));

    const prefix = await getPrefix(message.guild.id);
    if (!message.content.startsWith(prefix)) return;

    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();
    const command = client.commands.get(commandName);
    if (!command) return;

    // allow /prefix reward claim for everyone
    let allowed = await hasPermission(message.author.id, message.guild.id, message.guild.ownerId);
    if (!allowed) {
      if (commandName === 'reward') {
        const subArg = args[0];
        if (!subArg || subArg.toLowerCase() === 'claim') allowed = true;
      }
    }
    if (!allowed) return message.reply("❌ You don't have permission to use this command.");

    try { await command.execute(message, args); }
    catch (err) { console.error(err); message.reply("❌ Command error"); }
  } catch (err) {
    console.error('messageCreate handler error:', err);
  }
});

// --- SLASH COMMAND HANDLER ---
client.on('interactionCreate', async interaction => {
  try {
    if (!interaction.isChatInputCommand()) return;
    const cmd = client.commands.get(interaction.commandName);
    if (!cmd) return;

    // get subcommand if any
    let sub = null;
    try { sub = interaction.options.getSubcommand(false); } catch (e) { sub = null; }

    // allow public reward claim
    let allowed = await hasPermission(interaction.user.id, interaction.guildId ? interaction.guildId : null, (interaction.guild ? interaction.guild.ownerId : null));
    if (!allowed) {
      if (cmd.name === 'reward' && (!sub || sub === 'claim')) allowed = true;
    }
    if (!allowed) return interaction.reply({ content: "❌ You don't have permission to use this command.", ephemeral: true });

    // build args array for compatibility
    const args = cmd.options?.map(opt => interaction.options.get(opt.name)?.value) || [];

    try {
      await cmd.execute(interaction, args);
    } catch (err) {
      console.error(err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Slash command error', ephemeral: true });
      }
    }
  } catch (err) {
    console.error('interactionCreate handler error:', err);
  }
});

// --- Reaction handler for manual grants ---
// messageReactionAdd handler — replace existing one in index.js
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;

    console.log('[REACTION EVENT] user=', user.id, 'emoji=', reaction.emoji?.name, 'partial=', reaction.partial);

    // fetch partials if necessary
    if (reaction.partial) {
      try { await reaction.fetch(); } catch (e) { console.error('Failed to fetch reaction partial', e); return; }
    }
    const message = reaction.message;
    if (message.partial) {
      try { await message.fetch(); } catch (e) { console.error('Failed to fetch message partial', e); return; }
    }

    // Only process the green check emoji
    if (reaction.emoji.name !== '✅') return;

    const embed = message.embeds?.[0];
    if (!embed) {
      console.log('[REACTION] no embed -> ignore');
      return;
    }
    if (embed.title !== 'Manual Reward Required') {
      console.log('[REACTION] embed title not Manual Reward Required -> ignore:', embed.title);
      return;
    }

    // Already processed?
    const already = (embed.fields || []).some(f => f.name === 'Granted by');
    if (already) {
      console.log('[REACTION] already granted -> ignore');
      // Optionally remove reactor's reaction to clean up UX
      try { await reaction.users.remove(user.id).catch(()=>{}); } catch {}
      return;
    }

    // extract guildId (fallback to message.guild.id)
    const guildIdField = (embed.fields || []).find(f => f.name === 'GuildId');
    const guildId = guildIdField?.value ?? (message.guild?.id ?? null);

    // check moderator rights
    const allowed = await isMod(user.id, guildId);
    if (!allowed) {
      console.log('[REACTION] reactor is not mod, ignoring', user.id);
      // remove the user's reaction so it's not left behind (optional)
      try { await reaction.users.remove(user.id).catch(()=>{}); } catch {}
      return;
    }

    // parse discord id from embed Discord user field
    const discordUserField = (embed.fields || []).find(f => f.name === 'Discord user')?.value || '';
    const discordIdMatch = discordUserField.match(/\((\d{16,20})\)$/);
    const discordId = discordIdMatch ? discordIdMatch[1] : null;

    // Build new embed: change title, color and add "Granted by" field
    const newEmbed = EmbedBuilder.from(embed)
      .setTitle('Reward granted by administrator')
      .setColor(0x2ECC71) // green
      // remove any existing 'Granted by' field to avoid duplicates, then add
      ;

    // Remove existing Granted by if present
    const filteredFields = (newEmbed.data.fields || []).filter(f => f.name !== 'Granted by');
    newEmbed.data.fields = filteredFields;
    newEmbed.addFields({ name: 'Granted by', value: `${user.tag} (${user.id})`, inline: true });

    // Edit message with new embed
    try {
      await message.edit({ embeds: [newEmbed] });
      console.log('[REACTION] edited manual reward message to mark granted');
    } catch (e) {
      console.error('Failed to edit manual reward message', e);
    }

    // Remove the entire ✅ reaction from message (requires MANAGE_MESSAGES)
    try {
      await reaction.remove(); // removes the reaction from message entirely
      console.log('[REACTION] removed reaction from message');
    } catch (e) {
      console.warn('[REACTION] could not remove full reaction (maybe missing MANAGE_MESSAGES). Trying to remove only moderator\'s reaction.', e?.message || e);
      try { await reaction.users.remove(user.id).catch(()=>{}); } catch (e2) { console.warn('Failed fallback removal of user reaction', e2); }
    }

    // DM the player informing that admin granted the reward
    if (discordId) {
      try {
        const player = await client.users.fetch(discordId).catch(()=>null);
        if (player) {
          const rewardName = embed.fields.find(f => f.name === 'Reward')?.value ?? 'unknown';
          await player.send(`Your requested reward **${rewardName}** has been **granted** by ${user.tag}. Congratulations!`).catch(() => {
            console.warn('[REACTION] could not DM player (maybe DMs closed)');
          });
          console.log('[REACTION] sent DM to player', discordId);
        }
      } catch (e) {
        console.error('Failed to DM player after manual grant', e);
      }
    }

  } catch (err) {
    console.error('messageReactionAdd handler error:', err);
  }
});

// --- LOGIN ---
client.login(TOKEN);
