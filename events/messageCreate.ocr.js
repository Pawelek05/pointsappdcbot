// events/messageCreate.ocr.js
// Robust OCR handler with compatibility fallback for different tesseract.js versions.
// Sends only the ID (16 hex chars) when recognized. Messages in English.

import GuildConfig from '../models/GuildConfig.js';
import * as Tesseract from 'tesseract.js';
import { createWorker as createWorkerNamed } from 'tesseract.js'; // may or may not exist depending on version
import sharp from 'sharp';
import PlayFab from 'playfab-sdk';

// Enable PlayFab validation if you have PlayFab.settings.developerSecretKey set
const PLAYFAB_VALIDATE = true;

// cooldown per channel
const channelCooldowns = new Map();
const COOLDOWN_MS = 8000; // increase if you want less frequent OCR per channel

// regex for 16-char hex PlayFab ID
const PLAYFAB_ID_REGEX = /\b[A-F0-9]{16}\b/;

// aggressive char map for common OCR mistakes
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

// ambiguity pools used to generate variants
const AMBIG = {
  'O':['0','O'],'0':['0','O'],'Q':['0','Q'],'D':['0','D'],
  'I':['1','I','l'],'1':['1','I','l'],'l':['1','l'],
  'S':['5','S'],'5':['5','S'],
  'Z':['2','Z'],'2':['2','Z'],
  'B':['8','B'],'8':['8','B'],
  'G':['6','G'],'6':['6','G'],
  'q':['9','Q','9'],'P':['9','P'],
  'T':['7','T'],'7':['7','T']
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

// ---------- Tesseract compatibility layer ----------

// We'll try to use a worker if available and has the expected API.
// If not, fall back to calling Tesseract.recognize directly.
let tessWorkerPromise = null;
let useFallbackRecognize = false;

async function initTesseractWorker() {
  // If a previously failed attempt set fallback, short-circuit
  if (useFallbackRecognize) return null;

  if (tessWorkerPromise) return tessWorkerPromise;

  tessWorkerPromise = (async () => {
    try {
      // Prefer named createWorker if available
      const createWorker = typeof createWorkerNamed === 'function' ? createWorkerNamed : (Tesseract && typeof Tesseract.createWorker === 'function' ? Tesseract.createWorker : null);

      if (!createWorker) {
        // No createWorker available — fall back
        useFallbackRecognize = true;
        tessWorkerPromise = null;
        return null;
      }

      const worker = createWorker({
        // logger: m => console.log('[tess]', m)
      });

      // Some tesseract.js versions expose load as async fn on worker, some expect other flow.
      // We attempt to call load()/loadLanguage()/initialize(). If any step fails, fallback.
      if (typeof worker.load !== 'function') {
        // Unexpected API — fallback
        useFallbackRecognize = true;
        tessWorkerPromise = null;
        return null;
      }

      await worker.load();

      // loadLanguage sometimes expects array; handle both possibilities
      try {
        if (typeof worker.loadLanguage === 'function') {
          // Some versions accept an array, some accept a string. Try array first.
          try {
            await worker.loadLanguage(['eng']);
          } catch (e1) {
            // try string fallback
            await worker.loadLanguage('eng');
          }
        }
      } catch (e) {
        // if language loading fails, fallback
        console.warn('Tesseract: loadLanguage failed, falling back to recognize API.', e);
        useFallbackRecognize = true;
        tessWorkerPromise = null;
        return null;
      }

      // initialize with language code
      try {
        if (typeof worker.initialize === 'function') {
          await worker.initialize('eng');
        }
      } catch (e) {
        console.warn('Tesseract: initialize failed, falling back.', e);
        useFallbackRecognize = true;
        tessWorkerPromise = null;
        return null;
      }

      // set parameters - whitelist and page segmentation mode
      try {
        if (typeof worker.setParameters === 'function') {
          await worker.setParameters({
            tessedit_char_whitelist: '0123456789ABCDEF:',
            tessedit_pageseg_mode: '7'
          });
        }
      } catch (e) {
        // not fatal; continue
      }

      return worker;
    } catch (err) {
      console.error('Tesseract worker initialization error:', err);
      tessWorkerPromise = null;
      useFallbackRecognize = true;
      return null;
    }
  })();

  return tessWorkerPromise;
}

// recognition function that works with worker or falls back to Tesseract.recognize
async function tesseractRecognizeBuffer(buffer) {
  // initialize worker attempt (if not yet attempted)
  const worker = await initTesseractWorker();

  if (useFallbackRecognize || !worker) {
    // Fallback: use Tesseract.recognize directly
    try {
      const res = await Tesseract.recognize(buffer, 'eng', {
        logger: () => {}
      });
      return (res?.data?.text) ? res.data.text : '';
    } catch (err) {
      console.error('Tesseract fallback recognize error:', err);
      return '';
    }
  } else {
    // Use worker API
    try {
      const r = await worker.recognize(buffer);
      return (r?.data?.text) ? r.data.text : '';
    } catch (err) {
      console.warn('Tesseract worker recognize error, switching to fallback:', err);
      // mark fallback for next runs
      useFallbackRecognize = true;
      // try fallback now
      try {
        const res = await Tesseract.recognize(buffer, 'eng', { logger: () => {} });
        return (res?.data?.text) ? res.data.text : '';
      } catch (err2) {
        console.error('Tesseract fallback after worker failure also failed:', err2);
        return '';
      }
    }
  }
}

// ---------- Preprocessing variants (aggressive, slower) ----------

function makeDilateKernel(size = 3) {
  const k = size * size;
  return { width: size, height: size, kernel: new Array(k).fill(1) };
}

async function buildAggressiveVariants(maskPngBuffer) {
  const variants = [];

  // several thresholds
  const thresholds = [200, 180, 160, 140];
  for (const t of thresholds) {
    try {
      const buf = await sharp(maskPngBuffer)
        .grayscale()
        .normalize()
        .threshold(t)
        .toFormat('png')
        .toBuffer();
      variants.push(buf);
    } catch (e) {}
  }

  // upsample + convolve (thicken) + threshold
  try {
    const meta = await sharp(maskPngBuffer).metadata();
    const wup = Math.max(Math.round((meta.width || 100) * 2.5), 200);
    const up = await sharp(maskPngBuffer).resize({ width: wup, kernel: 'nearest' }).toBuffer();
    const dil = await sharp(up).convolve(makeDilateKernel(3)).threshold(140).toFormat('png').toBuffer();
    variants.push(dil);
  } catch (e) {}

  // sharpen + normalize + threshold
  try {
    const v = await sharp(maskPngBuffer).grayscale().sharpen().normalize().threshold(150).toFormat('png').toBuffer();
    variants.push(v);
  } catch (e) {}

  // median + sharpen + threshold
  try {
    const v = await sharp(maskPngBuffer).grayscale().median(1).sharpen().threshold(150).toFormat('png').toBuffer();
    variants.push(v);
  } catch (e) {}

  // enlarge then light blur then threshold
  try {
    const meta = await sharp(maskPngBuffer).metadata();
    const upw = Math.max(Math.round((meta.width || 100) * 1.8), 150);
    const v = await sharp(maskPngBuffer).resize({ width: upw, kernel: 'nearest' }).grayscale().blur(0.3).normalize().threshold(140).toFormat('png').toBuffer();
    variants.push(v);
  } catch (e) {}

  // original last
  variants.push(maskPngBuffer);

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

// ---------- Main handler ----------

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

    // fetch the image
    const res = await fetch(attachment.url);
    if (!res.ok) return;
    const arrayBuffer = await res.arrayBuffer();
    const imgBuffer = Buffer.from(arrayBuffer);

    // resize and raw extract
    const meta = await sharp(imgBuffer).metadata();
    const maxW = 1400;
    const scale = meta.width > maxW ? maxW / meta.width : 1;

    const raw = await sharp(imgBuffer).resize(Math.round((meta.width || maxW) * scale)).raw().toBuffer({ resolveWithObject: true });
    const { data, info } = raw;
    const w = info.width, h = info.height, ch = info.channels;

    // strict green mask
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
      await message.channel.send('❌ No green text (ID) detected on the image.');
      return;
    }

    minx = Math.max(0, minx - 10);
    miny = Math.max(0, miny - 10);
    maxx = Math.min(w - 1, maxx + 10);
    maxy = Math.min(h - 1, maxy + 10);
    const cropW = maxx - minx + 1;
    const cropH = maxy - miny + 1;

    // mask PNG (invert to black on white)
    const maskPng = await sharp(Buffer.from(mask), { raw: { width: w, height: h, channels: 1 } })
      .extract({ left: minx, top: miny, width: cropW, height: cropH })
      .negate()
      .toFormat('png')
      .toBuffer();

    // aggressive preprocessing (slower)
    const preVariants = await buildAggressiveVariants(maskPng);

    // run OCR sequentially on variants
    const ocrResults = [];
    for (const buf of preVariants) {
      try {
        const text = await tesseractRecognizeBuffer(buf);
        const clean = (text || '').replace(/\s+/g, '');
        if (clean) ocrResults.push(clean);
      } catch (e) {
        // ignore individual variant errors
      }
    }

    if (ocrResults.length === 0) {
      await message.channel.send('❌ OCR failed to read text from the image.');
      return;
    }

    // collect normalized candidates with votes
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
      const normalized = candidate.split('').map(ch => CHAR_MAP[ch] || ch).join('').toUpperCase();
      candidates.set(normalized, (candidates.get(normalized) || 0) + 1);
    }

    // sort candidates by votes
    const sorted = Array.from(candidates.entries()).sort((a,b)=>b[1]-a[1]).map(e=>e[0]);

    // helper to test candidate (direct or via variants) and optionally validate
    async function testCandidate(candidate) {
      const direct = candidate.match(PLAYFAB_ID_REGEX);
      if (direct) {
        const id = direct[0];
        if (PLAYFAB_VALIDATE) {
          const ok = await tryValidatePlayFab(id);
          if (ok) { await message.channel.send(id); return true; }
          return false;
        } else {
          await message.channel.send(id); return true;
        }
      }
      // try variants
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

    // try sorted candidates
    for (const cand of sorted) {
      const ok = await testCandidate(cand);
      if (ok) return;
    }

    // fallback: use most frequent OCR string aggressively normalized
    const fallbackRaw = ocrResults[0] || '';
    const fallbackCandidate = fallbackRaw.replace(/[^A-Za-z0-9]/g,'').split('').map(ch=>CHAR_MAP[ch]||ch).join('').toUpperCase();
    const fbOk = await testCandidate(fallbackCandidate);
    if (fbOk) return;

    // final fallback: take alnum trimmed/padded to 16 if possible
    const fallback2 = fallbackCandidate.replace(/[^A-Z0-9]/g,'').slice(0,16);
    if (fallback2.length === 16) {
      await message.channel.send(fallback2);
      return;
    }

    await message.channel.send('❌ Failed to clearly read the ID (try a higher-contrast screenshot).');
  } catch (err) {
    console.error('OCR handler error:', err);
  }
}
