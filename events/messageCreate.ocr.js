// events/messageCreate.ocr.js
import GuildConfig from '../models/GuildConfig.js';
import { recognizeImageBuffer } from '../utils/ocrWorker.js';

// cooldown per channel to avoid spam/OCR flood
const channelCooldowns = new Map();
const COOLDOWN_MS = 8000; // 8s

// dopasowanie 16-znakowego hex (przykład: 9E5102A2E915D10D)
const PLAYFAB_ID_REGEX = /\b[A-Fa-f0-9]{16}\b/;

export default async function ocrMessageHandler(message) {
  try {
    if (message.author?.bot) return;
    if (!message.guild) return;

    const cfg = await GuildConfig.findOne({ guildId: message.guild.id });
    if (!cfg?.ocrChannelId) return;
    if (message.channel.id !== cfg.ocrChannelId) return;

    // cooldown
    const now = Date.now();
    const last = channelCooldowns.get(message.channel.id) || 0;
    if (now - last < COOLDOWN_MS) return;
    channelCooldowns.set(message.channel.id, now);

    // attachment existence
    const attachment = message.attachments?.first();
    if (!attachment) return;

    const contentType = attachment.contentType || '';
    const filename = attachment.name || '';
    if (!contentType.startsWith('image/') && !/\.(jpe?g|png|bmp|webp|gif)$/i.test(filename)) return;

    // fetch image buffer (Node 18+ has global fetch)
    const res = await fetch(attachment.url);
    if (!res.ok) {
      console.warn('OCR: failed to fetch image', res.status);
      return;
    }
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const text = await recognizeImageBuffer(buffer);
    if (!text || !text.trim()) {
      // opcjonalnie odpowiedz że nie ma tekstu
      await message.channel.send('❌ Nie wykryto czytelnego tekstu na obrazie.');
      return;
    }

    const match = text.match(PLAYFAB_ID_REGEX);
    if (match) {
      const id = match[0].toUpperCase();
      await message.channel.send(`ID: ${id}`);
    } else {
      await message.channel.send('❌ Nie wykryto PlayFab ID na obrazie.');
    }
  } catch (err) {
    console.error('OCR handler error:', err);
    // nie spamujemy kanału błędami
  }
}
