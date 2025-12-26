import { Client, GatewayIntentBits, Collection, REST, Routes } from 'discord.js';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import GuildConfig from './models/GuildConfig.js';
import PlayFab from 'playfab-sdk';
const config = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf-8'));

// --- PLAYFAB ---
PlayFab.settings.titleId = "171DCA";

// --- ENV CHECK ---
const { TOKEN, CLIENT_ID, MONGO_URI } = process.env;
if (!TOKEN || !CLIENT_ID || !MONGO_URI) {
  console.error("❌ Missing environment variables! Make sure TOKEN, CLIENT_ID, and MONGO_URI are set.");
  process.exit(1);
}

// --- DISCORD CLIENT ---
const client = new Client({ 
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] 
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
    slashCommands.push({ name: cmd.name, description: cmd.description || 'No description' });
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

// --- MESSAGE COMMAND HANDLER ---
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  const prefix = await getPrefix(message.guild.id);
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const commandName = args.shift().toLowerCase();
  const command = client.commands.get(commandName);
  if (!command) return;

  const allowed = await hasPermission(message.author.id, message.guild.id, message.guild.ownerId);
  if (!allowed) return message.reply("❌ You don't have permission to use this command.");

  try { await command.execute(message, args); } 
  catch (err) { console.error(err); message.reply("❌ Command error"); }
});

// --- SLASH COMMAND HANDLER ---
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = client.commands.get(interaction.commandName);
  if (!cmd) return;

  const args = [];
  try {
    for (const opt of interaction.options.data) {
      if (opt.type === 1 && opt.options) {
        args.push(opt.name);
        for (const sub of opt.options) args.push(sub.value ?? sub.name);
      } else args.push(opt.value ?? opt.name);
    }
  } catch {}

  const allowed = await hasPermission(interaction.user.id, interaction.guildId, interaction.guild.ownerId);
  if (!allowed) return interaction.reply({ content: "❌ You don't have permission to use this command.", ephemeral: true });

  const fakeMsg = {
    guild: interaction.guild,
    author: interaction.user,
    member: interaction.member,
    channel: interaction.channel,
    client,
    reply: (contentOrOptions) => {
      if (typeof contentOrOptions === 'string') 
        return interaction.reply({ content: contentOrOptions, ephemeral: false });
      return interaction.reply({ ...contentOrOptions, ephemeral: false });
    }
  };

  try { await cmd.execute(fakeMsg, args); }
  catch (err) { console.error(err); interaction.reply({ content: '❌ Slash command error', ephemeral: true }); }
});

// --- LOGIN ---
client.login(TOKEN);
