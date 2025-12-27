// utils/isMod.js
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import GuildConfig from '../models/GuildConfig.js';

// resolve __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// load config.json safely (no import assertion)
let config = {};
try {
  const cfgPath = path.join(__dirname, '..', 'config.json');
  const raw = readFileSync(cfgPath, 'utf8');
  config = JSON.parse(raw);
  config.ownerId = config.ownerId ?? null;
} catch (err) {
  console.error('utils/isMod.js: failed to load config.json:', err);
  config = { ownerId: null };
}

export default async function isMod(userId, guildId) {
  if (!userId) return false;

  // owner from config.json has full rights
  if (config.ownerId && String(userId) === String(config.ownerId)) return true;

  try {
    const cfg = await GuildConfig.findOne({ guildId: String(guildId) });
    const mods = cfg?.mods ?? [];
    // ensure both compared values are strings
    return Array.isArray(mods) && mods.map(String).includes(String(userId));
  } catch (err) {
    console.error('isMod - DB error:', err);
    return false;
  }
}
