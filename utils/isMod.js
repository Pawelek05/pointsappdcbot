// utils/isMod.js
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import GuildConfig from '../index.js';

// resolve __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// load config.json safely (no import assertion needed)
let config = {};
try {
  const cfgPath = path.join(__dirname, '..', 'config.json');
  const raw = readFileSync(cfgPath, 'utf8');
  config = JSON.parse(raw);
} catch (err) {
  // jeśli nie uda się wczytać pliku, logujemy błąd i fallbackujemy do bezpiecznych wartości
  console.error('Failed to load config.json in utils/isMod.js:', err);
  config = { ownerId: null };
}

export default async function isMod(userId, guildId) {
  if (!userId) return false;
  if (config.ownerId && userId === config.ownerId) return true;

  try {
    const cfg = await GuildConfig.findOne({ guildId });
    const mods = cfg?.mods ?? [];
    return Array.isArray(mods) && mods.includes(userId);
  } catch (err) {
    console.error('isMod - DB error:', err);
    return false;
  }
}
