
// models/GuildConfig.js
import mongoose from 'mongoose';

const GuildConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  prefix: { type: String, default: "=" },
  mods: { type: [String], default: [] },
  ocrChannelId: { type: String, default: null }, // existing field
  // NEW: channel to post reward alerts
  rewardChannelId: { type: String, default: null },
  // NEW: whether to post alerts when someone redeems a reward
  rewardAlerts: { type: Boolean, default: true }
});

GuildConfigSchema.index({ guildId: 1 }, { unique: true });

export default mongoose.model('GuildConfig', GuildConfigSchema);
