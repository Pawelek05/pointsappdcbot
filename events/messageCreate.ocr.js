// events/messageCreate.ocr.js
// Bardziej odporny, wolniejszy OCR z agresywnym preprocessingiem.
// Wysyła tylko sam ID (bez "ID:").
import GuildConfig from '../models/GuildConfig.js';
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import PlayFab from 'playfab-sdk';

// Jeśli chcesz walidować przez PlayFab, ustaw true (wymaga developerSecretKey)
const PLAYFAB_VALIDATE = true;

// cooldown per channel
const channelCooldowns = new Map();
const COOLDOWN_MS = 8000; // możesz wydłużyć jeśli wolniejsza operacja powoduje przeciążenie

// regex dla 16-znakowego hex
const PLAYFAB_ID_REGEX = /\b[A-F0-9]{16}\b/;

// Bardziej rozbudowana mapa pomyłek OCR
const CHAR_MAP = {
  'O':'0','o':'0','Q':'0','D':'0',
  'I':'1','l':'1','i':'1','!':'1','|':'1',
  'S':'5','s':'5',
  'Z':'2','z':'2',
  'B':'8','b':'8',
  'G':'6','g':'9',
  'q':'9','P':'9',
  'T':'7','t':'7'
};

// Ambiguity pools do generowania wariantów (rozszerzone)
const AMBIG = {
  'O':['0','O'],
  '0':['0','O'],
  'Q':['0','Q'],
  'D':['0','D'],
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
  'q':['9','Q','9'],
  'P':['9','P'],
  'T':['7','T'],
  '7':['7','T']
};

function generateVariants(s) {
  const chars = s.split('');
  const pools = chars.map(ch => AMBIG[ch] || [ch]);
  const MAX_VARIANTS = 256;
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


let tessWorkerPromise = null;
async function getTessWorker() {
  if (!tessWorkerPromise) {
    tessWorkerPromise = (async () => {
      try {
        const worker = createWorker({
          // logger: m => console.log('[tess]', m)
        });

        await worker.load();                        // load core
        // Uwaga: loadLanguage oczekuje tablicy w wielu wersjach tesseract.js
        await worker.loadLanguage(['eng']);         // <- tutaj podajemy tablicę
        await worker.initialize('eng');             // initialize with language code (string)
        // ustaw parametry - PSM jako string lub liczba działa, tutaj bezpiecznie jako '7'
        await worker.setParameters({
          tessedit_char_whitelist: '0123456789ABCDEF:', // tylko hex + colon
          tessedit_pageseg_mode: '7' // treat the image as a single text line
        });
        return worker;
      } catch (err) {
        console.error('Tesseract worker initialization failed:', err);
        // W razie niepowodzenia wyczyść promise, aby można było spróbować ponownie
        tessWorkerPromise = null;
        throw err;
      }
    })();
  }
  return tessWorkerPromise;
}

async function tesseractRecognizeBuffer(buffer) {
  const worker = await getTessWorker();
  const { data: { text } } = await worker.recognize(buffer);
  return text || '';
}

// Morphological thickening via convolution: sharp.convolve with kernel of ones (approx dilation)
function makeDilateKernel(size = 3) {
  const k = size * size;
  const kernel = { width: size, height: size, kernel: new Array(k).fill(1) };
  return kernel;
}

// Budujemy zestaw wariantów preprocessed (agresywne)
async function buildAggressiveVariants(maskPngBuffer) {
  const variants = [];

  // 1) Normalize + threshold (several thresholds)
  const thresholds = [180, 160, 140, 130];
  for (const t of thresholds) {
    try {
      const buf = await sharp(maskPngBuffer)
        .grayscale()
        .normalize()
        .threshold(t)
        .toFormat('png')
        .toBuffer();
      variants.push(buf);
    } catch (e) { /* ignore */ }
  }

  // 2) Resize up x3 (nearest to keep edges) -> convolve (thicken) -> threshold
  try {
    const meta = await sharp(maskPngBuffer).metadata();
    const w = Math.max( Math.round((meta.width || 100) * 3), 100 );
    const up = await sharp(maskPngBuffer)
      .resize({ width: w, kernel: 'nearest' })
      .grayscale()
      .toBuffer();
    // convolve 3x3 of ones to thicken strokes
    const dilated = await sharp(up)
      .convolve(makeDilateKernel(3))
      .threshold(140)
      .toFormat('png')
      .toBuffer();
    variants.push(dilated);
  } catch (e) {}

  // 3) sharpen + normalize + threshold
  try {
    const v = await sharp(maskPngBuffer)
      .grayscale()
      .sharpen()
      .normalize()
      .threshold(150)
      .toFormat('png')
      .toBuffer();
    variants.push(v);
  } catch (e) {}

  // 4) median + sharpen + threshold
  try {
    const v = await sharp(maskPngBuffer)
      .grayscale()
      .median(1)
      .sharpen()
      .threshold(150)
      .toFormat('png')
      .toBuffer();
    variants.push(v);
  } catch (e) {}

  // 5) enlarge then gaussian blur slight then threshold (sometimes reduces noise)
  try {
    const meta = await sharp(maskPngBuffer).metadata();
    const upw = Math.max(Math.round((meta.width || 100) * 2), 100);
    const v = await sharp(maskPngBuffer)
      .resize({ width: upw, kernel: 'nearest' })
      .grayscale()
      .blur(0.3)
      .normalize()
      .threshold(140)
      .toFormat('png')
      .toBuffer();
    variants.push(v);
  } catch (e) {}

  // 6) Original as last resort
  variants.push(maskPngBuffer);

  // ensure unique buffers (some may be identical) — keep order
  return variants;
}

// PlayFab validation helper
async function tryValidatePlayFab(id) {
  if (!PLAYFAB_VALIDATE) return false;
  try {
    const payload = { PlayFabId: id };
    const res = await new Promise((resolve) => {
      PlayFab.PlayFabServer.GetUserAccountInfo(payload, (err, result) => resolve({ err, result }));
    });
    if (!res.err && res.result?.data?.UserInfo?.PlayFabId === id) return true;
  } catch (e) {}
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

    // fetch
    const res = await fetch(attachment.url);
    if (!res.ok) return;
    const arrayBuffer = await res.arrayBuffer();
    const imgBuffer = Buffer.from(arrayBuffer);

    // metadata + scale
    const meta = await sharp(imgBuffer).metadata();
    const maxW = 1400; // większa szerokość -> lepsze OCR, kosztem CPU
    const scale = meta.width > maxW ? maxW / meta.width : 1;

    const raw = await sharp(imgBuffer)
      .resize(Math.round((meta.width || maxW) * scale))
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = raw;
    const w = info.width, h = info.height, ch = info.channels;

    // Create green mask: stricter thresholds to avoid noise
    const delta = 24;
    const minG = 110;
    const mask = Buffer.alloc(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * ch;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
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
      await message.channel.send('❌ Nie wykryto zielonego tekstu (ID) na obrazie.');
      return;
    }

    minx = Math.max(0, minx - 8);
    miny = Math.max(0, miny - 8);
    maxx = Math.min(w - 1, maxx + 8);
    maxy = Math.min(h - 1, maxy + 8);
    const cropW = maxx - minx + 1;
    const cropH = maxy - miny + 1;

    // Build mask PNG (invert to black text on white)
    const maskPng = await sharp(Buffer.from(mask), { raw: { width: w, height: h, channels: 1 } })
      .extract({ left: minx, top: miny, width: cropW, height: cropH })
      .negate()
      .toFormat('png')
      .toBuffer();

    // Aggressive preprocessing variants
    const preVariants = await buildAggressiveVariants(maskPng);

    // OCR each variant sequentially (prefer slower reliable)
    const ocrResults = [];
    for (const buf of preVariants) {
      try {
        const text = await tesseractRecognizeBuffer(buf);
        const clean = (text || '').replace(/\s+/g, '');
        if (clean) ocrResults.push(clean);
      } catch (e) {
        // ignore
      }
    }

    if (ocrResults.length === 0) {
      await message.channel.send('❌ OCR nie odczytał tekstu z obrazu.');
      return;
    }

    // collect normalized candidates with vote counts
    const candidates = new Map();
    for (const rawText of ocrResults) {
      let candidate = null;
      const idMatch = rawText.match(/ID[:\-]?([A-Za-z0-9]+)/i);
      if (idMatch) candidate = idMatch[1];
      else {
        const hexOnly = rawText.match(/[A-Fa-f0-9]{12,}/);
        if (hexOnly) candidate = hexOnly[0];
      }
      if (!candidate) continue;
      // normalize with CHAR_MAP (aggressive)
      const normalized = candidate.split('').map(ch => CHAR_MAP[ch] || ch).join('').toUpperCase();
      candidates.set(normalized, (candidates.get(normalized) || 0) + 1);
    }

    // Sort by votes
    const sorted = Array.from(candidates.entries()).sort((a,b)=>b[1]-a[1]).map(e=>e[0]);

    // Helper: try candidate directly or via variants and optionally validate via PlayFab
    async function testCandidate(candidate) {
      // if direct 16 hex
      const direct = candidate.match(PLAYFAB_ID_REGEX);
      if (direct) {
        const id = direct[0];
        if (PLAYFAB_VALIDATE) {
          const ok = await tryValidatePlayFab(id);
          if (ok) {
            await message.channel.send(id); // tylko id
            return true;
          }
          return false;
        } else {
          await message.channel.send(id);
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
          if (ok) { await message.channel.send(id); return true; }
        } else {
          await message.channel.send(id); return true;
        }
      }
      return false;
    }

    // Try top sorted candidates
    for (const cand of sorted) {
      const ok = await testCandidate(cand);
      if (ok) return;
    }

    // fallback: try the most frequent raw OCR string mapped aggressively
    const fallbackRaw = ocrResults[0] || '';
    const fallbackCandidate = fallbackRaw.replace(/[^A-Za-z0-9]/g,'').split('').map(ch=>CHAR_MAP[ch]||ch).join('').toUpperCase();
    const fbOk = await testCandidate(fallbackCandidate);
    if (fbOk) return;

    // final fallback: take alphanum, trim/pad to 16 (only if length >=16) and send best-effort
    const fallback2 = fallbackCandidate.replace(/[^A-Z0-9]/g,'').slice(0,16);
    if (fallback2.length === 16) {
      await message.channel.send(fallback2);
      return;
    }

    await message.channel.send('❌ Nie udało się jednoznacznie odczytać ID (spróbuj lepszy screenshot).');
  } catch (err) {
    console.error('OCR handler error:', err);
  }
}
