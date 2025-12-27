// events/messageCreate.ocr.js
import GuildConfig from '../models/GuildConfig.js';
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import PlayFab from 'playfab-sdk';

// jeśli chcesz walidować przez PlayFab ustaw true
const PLAYFAB_VALIDATE = true;

// cooldown per channel
const channelCooldowns = new Map();
const COOLDOWN_MS = 8000;

// regex dla 16-znakowego hex
const PLAYFAB_ID_REGEX = /\b[A-F0-9]{16}\b/;

// rozszerzona mapa „pomyłek OCR”
const CHAR_MAP = {
  'O':'0','o':'0','Q':'0','D':'0',
  'I':'1','l':'1','i':'1','!':'1',
  'S':'5','s':'5',
  'Z':'2','z':'2',
  'B':'8','b':'6', // czasem b->6 depending on font, ale zachowaj ostrożność
  'G':'6','g':'9',
  'q':'9','P':'9',
  'T':'7'
};

// ambig mapping pools do generowania wariantów
const AMBIG = {
  'O':['0','O'],
  'o':['0','o'],
  '0':['0','O'],
  'I':['1','I','l'],
  '1':['1','I','l'],
  'l':['1','l'],
  'S':['5','S'],
  '5':['5','S'],
  'Z':['2','Z'],
  '2':['2','Z'],
  'B':['8','B'],
  '8':['8','B'],
  'G':['6','G'],
  '6':['6','G'],
  'Q':['0','Q'],
  'D':['0','D'],
  'T':['7','T'],
  '7':['7','T']
};

function generateVariants(s) {
  const chars = s.split('');
  const pools = chars.map(ch => AMBIG[ch] || [ch]);
  const MAX_VARIANTS = 128;
  let results = [''];
  for (const pool of pools) {
    const next = [];
    for (const prefix of results) {
      for (const c of pool) {
        next.push(prefix + c);
        if (next.length >= MAX_VARIANTS) break;
      }
      if (next.length >= MAX_VARIANTS) break;
    }
    results = next;
    if (results.length >= MAX_VARIANTS) break;
  }
  return results;
}

// worker singleton
let tessWorkerPromise = null;
async function getTessWorker() {
  if (!tessWorkerPromise) {
    tessWorkerPromise = (async () => {
      const worker = createWorker({
        // logger: m => console.log('[tess]', m)
      });
      await worker.load();
      await worker.loadLanguage('eng');
      await worker.initialize('eng');
      // whitelist: hex characters + optional colon (ID:)
      await worker.setParameters({
        tessedit_char_whitelist: '0123456789ABCDEF:',
        tessedit_pageseg_mode: '7', // treat as a single text line
      });
      return worker;
    })();
  }
  return tessWorkerPromise;
}

async function tesseractRecognizeBuffer(buffer) {
  const worker = await getTessWorker();
  const { data: { text } } = await worker.recognize(buffer);
  return text;
}

// pomocnicze: preprocessing wariantów — zwracamy tablicę bufferów do OCR
async function buildPreprocessedVariants(maskPngBuffer) {
  // warianty:
  // 1. normalize + threshold
  // 2. sharpen + threshold
  // 3. slight blur removal + threshold
  // 4. original mask (inverted) as fallback
  const variants = [];

  // wariant 1: normalize + threshold
  try {
    const v1 = await sharp(maskPngBuffer)
      .ensureAlpha()
      .grayscale()
      .normalize()     // popraw kontrast
      .threshold(160)  // binaryzacja
      .toFormat('png')
      .toBuffer();
    variants.push(v1);
  } catch (e) { /* ignore */ }

  // wariant 2: sharpen + threshold
  try {
    const v2 = await sharp(maskPngBuffer)
      .grayscale()
      .sharpen()
      .threshold(150)
      .toFormat('png')
      .toBuffer();
    variants.push(v2);
  } catch (e) {}

  // wariant 3: resize up (powiększ) -> normalize -> threshold (czasem pomaga małym znakom)
  try {
    const v3 = await sharp(maskPngBuffer)
      .grayscale()
      .resize({ width: Math.round( (await sharp(maskPngBuffer).metadata()).width * 1.6 ), withoutEnlargement: false })
      .normalize()
      .threshold(140)
      .toFormat('png')
      .toBuffer();
    variants.push(v3);
  } catch (e) {}

  // wariant 4: lekko rozmyj i sharpen (usuwa artefakty)
  try {
    const v4 = await sharp(maskPngBuffer)
      .grayscale()
      .median(1)
      .sharpen()
      .threshold(150)
      .toFormat('png')
      .toBuffer();
    variants.push(v4);
  } catch (e) {}

  // zawsze dodaj oryginal
  variants.push(maskPngBuffer);
  return variants;
}

async function tryValidatePlayFab(id) {
  if (!PLAYFAB_VALIDATE) return false;
  try {
    const payload = { PlayFabId: id };
    const res = await new Promise((resolve) => {
      PlayFab.PlayFabServer.GetUserAccountInfo(payload, (err, result) => resolve({ err, result }));
    });
    if (!res.err && res.result?.data?.UserInfo?.PlayFabId === id) return true;
  } catch (e) {
    // ignore
  }
  return false;
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

    const filename = attachment.name || '';
    if (!attachment.contentType?.startsWith('image/') && !/\.(jpe?g|png|bmp|webp|gif)$/i.test(filename)) return;

    const res = await fetch(attachment.url);
    if (!res.ok) return;
    const arrayBuffer = await res.arrayBuffer();
    const imgBuffer = Buffer.from(arrayBuffer);

    // resize, extract raw, mask green like before
    const meta = await sharp(imgBuffer).metadata();
    const maxW = 1000; // większa szerokość może poprawić rozpoznanie
    const scale = meta.width > maxW ? maxW / meta.width : 1;

    const raw = await sharp(imgBuffer)
      .resize(Math.round(meta.width * scale))
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = raw;
    const w = info.width, h = info.height, ch = info.channels;

    const delta = 30;
    const minG = 100;
    const mask = Buffer.alloc(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * ch;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        if (g > r + delta && g > b + delta && g >= minG) mask[y * w + x] = 255;
        else mask[y * w + x] = 0;
      }
    }

    // bounding box
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
      return;
    }

    minx = Math.max(0, minx - 6);
    miny = Math.max(0, miny - 6);
    maxx = Math.min(w - 1, maxx + 6);
    maxy = Math.min(h - 1, maxy + 6);
    const cropW = maxx - minx + 1;
    const cropH = maxy - miny + 1;

    const maskPng = await sharp(Buffer.from(mask), { raw: { width: w, height: h, channels: 1 } })
      .extract({ left: minx, top: miny, width: cropW, height: cropH })
      .negate() // invert: tekst czarny na białym
      .toFormat('png')
      .toBuffer();

    // build preprocessing variants
    const preVariants = await buildPreprocessedVariants(maskPng);

    // run OCR on each variant, collect texts
    const ocrResults = [];
    for (const buf of preVariants) {
      try {
        const text = await tesseractRecognizeBuffer(buf);
        ocrResults.push((text || '').replace(/\s+/g, ''));
      } catch (e) {
        // continue
      }
    }

    if (ocrResults.length === 0) {
      await message.channel.send('❌ OCR failed to read text.');
      return;
    }

    // pick best candidate from results: prefer any that matches ID pattern after normalization
    const candidates = new Map(); // candidate -> count
    for (const rawText of ocrResults) {
      // extract potential ID: try ID:XXXX or hex substrings of length >=12
      let candidate = null;
      const idMatch = rawText.match(/ID[:\-]?([A-Za-z0-9]+)/i);
      if (idMatch) candidate = idMatch[1];
      else {
        const hexOnly = rawText.match(/[A-Fa-f0-9]{12,}/);
        if (hexOnly) candidate = hexOnly[0];
      }
      if (!candidate) continue;
      // normalize with char map first
      const normalized = candidate.split('').map(ch => CHAR_MAP[ch] || ch).join('').toUpperCase();
      candidates.set(normalized, (candidates.get(normalized) || 0) + 1);
    }

    // sort candidates by votes
    const sorted = Array.from(candidates.entries()).sort((a,b) => b[1]-a[1]).map(e=>e[0]);

    // function to test candidate and variants
    async function testAndRespond(candidate) {
      // if candidate already matches 16 hex, test directly
      const direct = candidate.match(PLAYFAB_ID_REGEX);
      if (direct) {
        const id = direct[0];
        if (PLAYFAB_VALIDATE) {
          const ok = await tryValidatePlayFab(id);
          if (ok) {
            await message.channel.send(`ID: ${id}`);
            return true;
          }
          return false;
        } else {
          await message.channel.send(`ID: ${id}`);
          return true;
        }
      }
      // otherwise generate variants
      const vars = generateVariants(candidate);
      for (const v of vars) {
        const m = v.match(PLAYFAB_ID_REGEX);
        if (!m) continue;
        const id = m[0];
        if (PLAYFAB_VALIDATE) {
          const ok = await tryValidatePlayFab(id);
          if (ok) { await message.channel.send(`ID: ${id}`); return true; }
        } else {
          await message.channel.send(`ID: ${id}`); return true;
        }
      }
      return false;
    }

    // try sorted candidates first
    for (const cand of sorted) {
      const ok = await testAndRespond(cand);
      if (ok) return;
    }

    // as fallback, attempt variants from top OCR string (most frequent OCR result)
    const fallbackRaw = ocrResults[0] || '';
    // sanitize and map
    const fallbackCandidate = fallbackRaw.replace(/[^A-Za-z0-9]/g, '').split('').map(ch=>CHAR_MAP[ch]||ch).join('').toUpperCase();
    const fallbackOk = await testAndRespond(fallbackCandidate);
    if (fallbackOk) return;

    // final fallback: try trimmed alphanum to 16 chars
    const fallback2 = fallbackCandidate.replace(/[^A-Z0-9]/g,'').slice(0,16);
    if (fallback2.length === 16) {
      await message.channel.send(`ID: ${fallback2}`);
      return;
    }

    await message.channel.send('❌ Failed to clearly read the ID (try a better screenshot).');
  } catch (err) {
    console.error('OCR handler error:', err);
  }
}
