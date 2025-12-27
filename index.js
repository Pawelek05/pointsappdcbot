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
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    // debug: log reaction events (temporary)
    console.log('[REACTION EVENT] user=', user.id, 'emoji=', reaction.emoji?.name, 'partial=', reaction.partial);

    if (user.bot) return;

    // fetch if partial
    if (reaction.partial) {
      try { await reaction.fetch(); } catch (e) { console.error('Failed to fetch reaction partial', e); return; }
    }
    const message = reaction.message;
    if (message.partial) {
      try { await message.fetch(); } catch (e) { console.error('Failed to fetch message partial', e); return; }
    }

    // only care about ✅
    if (reaction.emoji.name !== '✅') return;

    const embed = message.embeds?.[0];
    if (!embed) {
      console.log('[REACTION] message has no embed, ignoring');
      return;
    }
    if (embed.title !== 'Manual Reward Required') {
      console.log('[REACTION] embed title not manual reward required, ignoring:', embed.title);
      return;
    }

    // already processed?
    const grantedField = (embed.fields || []).find(f => f.name === 'Granted by');
    if (grantedField) {
      console.log('[REACTION] already granted, ignoring');
      return;
    }

    // extract guildId (fallback to message.guild.id)
    const guildIdField = (embed.fields || []).find(f => f.name === 'GuildId');
    const guildId = guildIdField?.value ?? (message.guild?.id ?? null);

    // check moderator rights
    const allowed = await isMod(user.id, guildId);
    if (!allowed) {
      console.log('[REACTION] user is not mod, ignoring', user.id);
      return;
    }

    // parse discord id from embed Discord user field
    const discordUserField = (embed.fields || []).find(f => f.name === 'Discord user')?.value || '';
    const discordIdMatch = discordUserField.match(/\((\d{16,20})\)$/);
    const discordId = discordIdMatch ? discordIdMatch[1] : null;

    // build new embed: mark granted by
    const newEmbed = EmbedBuilder.from(embed)
      .setColor(0x2ECC71)
      .addFields({ name: 'Granted by', value: `${user.tag} (${user.id})`, inline: true });

    // edit the message
    try {
      await message.edit({ embeds: [newEmbed] });
      console.log('[REACTION] edited manual reward message to mark granted');
    } catch (e) {
      console.error('Failed to edit manual reward message', e);
    }

    // DM the player
    if (discordId) {
      try {
        const player = await client.users.fetch(discordId).catch(()=>null);
        if (player) {
          await player.send(`Your requested reward **${embed.fields.find(f=>f.name==='Reward')?.value ?? 'unknown'}** has been **granted** by ${user.tag}. Congratulations!`).catch(()=>{});
          console.log('[REACTION] sent DM to player', discordId);
        }
      } catch (e) {
        console.error('Failed to DM player after manual grant', e);
      }
    }

    // try to remove reaction from the moderator to avoid duplicates
    try {
      // requires MANAGE_MESSAGES permission for bot in that channel
      await reaction.users.remove(user.id);
    } catch (e) {
      console.warn('Could not remove moderator reaction (missing permission?):', e.message || e);
    }

  } catch (err) {
    console.error('messageReactionAdd handler error:', err);
  }
});

// --- LOGIN ---
client.login(TOKEN);
