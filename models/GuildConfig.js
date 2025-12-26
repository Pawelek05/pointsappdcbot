// models/GuildConfig.js
import mongoose from 'mongoose';

const GuildConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  prefix: { type: String, default: "=" },
  mods: { type: [String], default: [] },
  ocrChannelId: { type: String, default: null } // <- nowe pole
});

export default mongoose.model('GuildConfig', GuildConfigSchema);
