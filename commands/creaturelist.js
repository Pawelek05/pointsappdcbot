// commands/creaturelist.js
import { EmbedBuilder } from 'discord.js';
import { replySafe } from '../utils/commandHelpers.js';

const CREATURES = [
  "GhostRex_Special",
  "RainbowEyeBat_Special",
  "ColdSoldier_Special",
  "SteakChop_Base",
  "SPCMix",
  "PurpleCow_Awaken",
  "LegionOfEarlings_Base",
  "SunKing_Base",
  "Cornataur_Awaken",
  "DonkeyKhan_Base",
  "CaptainTaco_Base"
];

export default {
  name: "creaturelist",
  description: "Show available creature IDs",
  async execute(interactionOrMessage) {
    const embed = new EmbedBuilder()
      .setTitle("🧬 Available Creatures")
      .setDescription(
        CREATURES
          .map((id, i) => `**${i + 1}.** \`${id}\``)
          .join("\n")
      )
      .setColor(0x8E44AD)
      .setFooter({ text: "Use these IDs with /addcreature" })
      .setTimestamp();

    return replySafe(interactionOrMessage, null, { embeds: [embed], ephemeral: true });
  }
};