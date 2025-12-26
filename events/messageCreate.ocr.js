// events/messageCreate.ocr.js
import GuildConfig from '../models/GuildConfig.js';
import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import PlayFab from 'playfab-sdk'; // jeśli chcesz walidować przez PlayFab

// OPTIONAL: playfab must be configured (titleId + secret) in your index.js (you already do)
const PLAYFAB_VALIDATE = true; // ustaw false jeśli nie chcesz weryfikacji

// cooldown per channel
const channelCooldowns = new Map();
const COOLDOWN_MS = 8000;

// regex dla 16-znakowego hex
const PLAYFAB_ID_REGEX = /\b[A-F0-9]{16}\b/;

// mapowanie mylnych znaków (częste pomyłki OCR)
const CHAR_MAP = {
  'O':'0','o':'0',
  'I':'1','l':'1','i':'1',
  'S':'5','s':'5',
  'Z':'2','z':'2',
  'B':'8','G':'6','q':'9',
  'Q':'0'
};

// funkcja generująca warianty prostych niepewności (np. zamieniamy S<->5, O<->0, itp.)
function generateVariants(s) {
  const ambig = {
    'O':['0','O'],
    'o':['0','o'],
    '0':['0','O'],
    'I':['1','I'],
    '1':['1','I','l'],
    'l':['1','l'],
    'S':['5','S'],
    '5':['5','S'],
    'Z':['2','Z'],
    '2':['2','Z'],
    'B':['8','B'],
    '8':['8','B'],
    'G':['6','G'],
    '6':['6','G']
  };
  // dla wydajności: jeśli długość > 16 ignorujemy warianty
  const chars = s.split('');
  const pools = chars.map(ch => ambig[ch] || [ch]);
  // generuj kombinacje (gdy jest ich za dużo ograniczamy)
  const MAX_VARIANTS = 64;
  let results = [''];
  for (const pool of pools) {
    const next = [];
    for (const prefix of results) {
      for (const c of pool) {
        next.push(prefix + c);
        if (next.length > MAX_VARIANTS) break;
      }
      if (next.length > MAX_VARIANTS) break;
    }
    results = next;
    if (results.length > MAX_VARIANTS) break;
  }
  return results;
}

async function tesseractRecognize(buffer) {
  // uruchamiamy tesseract.js worker jednorazowo (tesseract może być ciężki - tesseract.js sam sobie zarządza)
  const { data: { text } } = await Tesseract.recognize(buffer, 'eng', {
    logger: m => {} // usuń lub loguj jeśli chcesz debug
  });
  return text;
}

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

    const attachment = message.attachments?.first();
    if (!attachment) return;

    // tylko obrazy
    const filename = attachment.name || '';
    if (!attachment.contentType?.startsWith('image/') && !/\.(jpe?g|png|bmp|webp|gif)$/i.test(filename)) return;

    // pobierz obraz (global fetch w Node 18+)
    const res = await fetch(attachment.url);
    if (!res.ok) return;
    const arrayBuffer = await res.arrayBuffer();
    const imgBuffer = Buffer.from(arrayBuffer);

    // Użyj sharp — zmniejszymy wielkość dla wydajności, ale zachowamy jakość tekstu
    const meta = await sharp(imgBuffer).metadata();
    // skalujemy szerokość do max 800px (zachowując proporcje)
    const maxW = 800;
    const scale = meta.width > maxW ? maxW / meta.width : 1;

    const raw = await sharp(imgBuffer)
      .resize(Math.round(meta.width * scale))
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = raw; // data = Uint8Array, info: {width, height, channels}
    const w = info.width, h = info.height, ch = info.channels;

    // Build mask where pixel is "green enough": G > R + delta && G > B + delta && G > minG
    const delta = 30;
    const minG = 100;
    const mask = Buffer.alloc(w * h); // single channel mask bytes

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * ch;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        if (g > r + delta && g > b + delta && g >= minG) {
          mask[y * w + x] = 255;
        } else {
          mask[y * w + x] = 0;
        }
      }
    }

    // Znajdź bounding box masky (gdzie są białe piksele)
    let minx = w, miny = h, maxx = 0, maxy = 0, found = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x]) {
          found = true;
          if (x < minx) minx = x;
          if (x > maxx) maxx = x;
          if (y < miny) miny = y;
          if (y > maxy) maxy = y;
        }
      }
    }

    if (!found) {
      await message.channel.send('❌ Nie wykryto zielonego tekstu (ID) na obrazie.');
      return;
    }

    // rozszerz bounding box o kilka px
    minx = Math.max(0, minx - 6);
    miny = Math.max(0, miny - 6);
    maxx = Math.min(w - 1, maxx + 6);
    maxy = Math.min(h - 1, maxy + 6);
    const cropW = maxx - minx + 1;
    const cropH = maxy - miny + 1;

    // Stwórz obraz z maski (binary) -> invert aby tesseract miał czarny tekst na białym tle
    const maskPng = await sharp(Buffer.from(mask), { raw: { width: w, height: h, channels: 1 } })
      .extract({ left: minx, top: miny, width: cropW, height: cropH })
      .negate() // invert: teraz tekst będzie czarny na białym
      .toFormat('png')
      .toBuffer();

    // Możemy także poprawić ostrość / kontrast tutaj, np. convolve/normalize jeśli potrzeba

    // Uruchom Tesseract z whitelistą do hex + dwukropek (ID:....)
    const tessRes = await tesseractRecognize(maskPng);
    let text = tessRes.replace(/\s+/g, '');
    // szukamy po wzorze "ID:..." lub samego hex
    let candidate = null;
    const idMatch = text.match(/ID[:]?([A-Za-z0-9]+)/i);
    if (idMatch) candidate = idMatch[1];
    else {
      const hexOnly = text.match(/[A-Fa-f0-9]{12,}/);
      if (hexOnly) candidate = hexOnly[0];
    }

    if (!candidate) {
      await message.channel.send('❌ OCR nie znalazł potencjalnego ID na obrazie.');
      return;
    }

    // normalizacja: mapuj prawdopodobne pomyłki
    let normalized = candidate.split('').map(ch => CHAR_MAP[ch] || ch).join('').toUpperCase();

    // jeśli już pasuje regex 16 hex -> zwróć go
    const direct = normalized.match(PLAYFAB_ID_REGEX);
    if (direct) {
      const id = direct[0];
      // opcjonalna walidacja PlayFab
      if (PLAYFAB_VALIDATE) {
        try {
          const payload = { PlayFabId: id };
          PlayFab.PlayFabServer.GetUserAccountInfo(payload, (err, result) => {
            if (!err && result?.data?.UserInfo?.PlayFabId === id) {
              message.channel.send(`ID: ${id}`);
            } else {
              // jeśli nie istnieje, spróbuj wariantów (np. zamiana S<->5 i O<->0)
              tryVariantsAndRespond(normalized, message);
            }
          });
        } catch (e) {
          // w razie problemów z PlayFab - odpowiedz normalized
          await message.channel.send(`ID: ${id}`);
        }
      } else {
        await message.channel.send(`ID: ${id}`);
      }
      return;
    }

    // jeśli nie pasuje bezpośrednio, generuj warianty i waliduj każdy (lub zwróć najlepszy)
    await tryVariantsAndRespond(normalized, message);
  } catch (err) {
    console.error('OCR handler error:', err);
  }
}

// pomocnicza funkcja próbująca wariantów i walidująca poprzez PlayFab (jeśli dostępny), zwraca pierwszy działający
async function tryVariantsAndRespond(base, message) {
  // generuj warianty
  const variants = generateVariants(base);
  for (const v of variants) {
    const m = v.match(/\b[A-F0-9]{16}\b/);
    if (!m) continue;
    const id = m[0];
    if (!PLAYFAB_VALIDATE) {
      await message.channel.send(`ID: ${id}`);
      return;
    }
    // waliduj
    try {
      const payload = { PlayFabId: id };
      const res = await new Promise((resolve) => {
        PlayFab.PlayFabServer.GetUserAccountInfo(payload, (err, result) => resolve({ err, result }));
      });
      if (!res.err && res.result?.data?.UserInfo?.PlayFabId === id) {
        await message.channel.send(`ID: ${id}`);
        return;
      }
    } catch (e) {
      // ignore errors per variant
    }
  }
  // jeżeli żaden wariant nie przeszedł walidacji - jako fallback zwróć najlepszy normalized (przytniety/pad)
  // spróbuj wyrównać długość na 16 znaków, dopełniając jeśli potrzeba (ale to raczej rzadkie)
  const fallback = base.replace(/[^A-Z0-9]/g,'').toUpperCase().slice(0,16);
  if (fallback.length === 16) {
    await message.channel.send(`ID: ${fallback}`);
  } else {
    await message.channel.send('❌ Failed to clearly read the ID (try taking a screenshot with better contrast)');
  }
}
