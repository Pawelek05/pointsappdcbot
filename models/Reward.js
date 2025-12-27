// models/Reward.js
import mongoose from 'mongoose';

const RewardSchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  rewardId: { type: String, required: true }, // e.g. "Gems", "SkinX", "Coins"
  name: { type: String, required: true },     // display name
  price: { type: Number, required: true },    // cost in PlayFab Money (coins)
  amount: { type: Number, required: true },   // how many Gems/units are granted
  emoji: { type: String, default: null },
  createdAt: { type: Date, default: () => new Date() }
});

RewardSchema.index({ guildId: 1, rewardId: 1 }, { unique: true });

export default mongoose.model('Reward', RewardSchema);
