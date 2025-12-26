import mongoose from 'mongoose';

const GuildConfigSchema = new mongoose.Schema({
  guildId: String,
  prefix: { type: String, default: "!" },
  mods: { type: [String], default: [] }
});

export default mongoose.model('GuildConfig', GuildConfigSchema);
