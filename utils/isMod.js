import GuildConfig from '../index.js';
import config from '../config.json' assert { type: 'json' };

export default async function isMod(userId, guildId) {
  if (userId === config.ownerId) return true;
  const cfg = await GuildConfig.findOne({ guildId });
  return cfg?.mods.includes(userId);
}
