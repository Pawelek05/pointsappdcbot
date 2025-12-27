// events/messageCreate.ocr.js
// Robust OCR handler with improved post-processing to fix common OCR misreads (e.g. letters <-> numbers).
// Sends only the ID (16 hex chars) when recognized. Messages in English.

import GuildConfig from '../models/GuildConfig.js';
import * as Tesseract from 'tesseract.js';
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
  'T':'7','t':'7',
  'y':'Y' // keep, will be removed later if not hex
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
  const MAX_VARIANTS = 512;
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

// ---------- Recognition (compatibility-friendly) ----------
async function tesseractRecognizeBuffer(buffer) {
  try {
    if (typeof Tesseract.recognize === 'function') {
      try {
        const res = await Tesseract.recognize(buffer, 'eng', { logger: () => {} });
        return res?.data?.text ?? '';
      } catch (e1) {
        try {
          const res2 = await Tesseract.recognize(buffer, ['eng'], { logger: () => {} });
          return res2?.data?.text ?? '';
        } catch (e2) {
          console.warn('Tesseract.recognize attempts failed:', e1, e2);
        }
      }
    }
    if (Tesseract && typeof Tesseract.default === 'object' && typeof Tesseract.default.recognize === 'function') {
      try {
        const res = await Tesseract.default.recognize(buffer, 'eng', { logger: () => {} });
        return res?.data?.text ?? '';
      } catch (e1) {
        try {
          const res2 = await Tesseract.default.recognize(buffer, ['eng'], { logger: () => {} });
          return res2?.data?.text ?? '';
        } catch (e2) {
          console.warn('Tesseract.default.recognize attempts failed:', e1, e2);
        }
      }
    }
  } catch (e) {
    console.warn('Tesseract direct recognize detection error:', e);
  }

  // If not found, return empty string - upstream will handle
  console.error('Tesseract: no recognize method available in this environment.');
  return '';
}

// ---------- Preprocessing (aggressive but slow) ----------
function makeDilateKernel(size = 3) {
  const k = size * size;
  return { width: size, height: size, kernel: new Array(k).fill(1) };
}

async function buildAggressiveVariants(maskPngBuffer) {
  const variants = [];

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

  try {
    const meta = await sharp(maskPngBuffer).metadata();
    const wup = Math.max(Math.round((meta.width || 100) * 2.5), 200);
    const up = await sharp(maskPngBuffer).resize({ width: wup, kernel: 'nearest' }).toBuffer();
    const dil = await sharp(up).convolve(makeDilateKernel(3)).threshold(140).toFormat('png').toBuffer();
    variants.push(dil);
  } catch (e) {}

  try {
    const v = await sharp(maskPngBuffer).grayscale().sharpen().normalize().threshold(150).toFormat('png').toBuffer();
    variants.push(v);
  } catch (e) {}

  try {
    const v = await sharp(maskPngBuffer).grayscale().median(1).sharpen().threshold(150).toFormat('png').toBuffer();
    variants.push(v);
  } catch (e) {}

  try {
    const meta = await sharp(maskPngBuffer).metadata();
    const upw = Math.max(Math.round((meta.width || 100) * 1.8), 150);
    const v = await sharp(maskPngBuffer).resize({ width: upw, kernel: 'nearest' }).grayscale().blur(0.3).normalize().threshold(140).toFormat('png').toBuffer();
    variants.push(v);
  } catch (e) {}

  variants.push(maskPngBuffer);
  return variants;
}

// PlayFab validation
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

// ---------- New robust candidate extraction ----------

// Normalize raw OCR string aggressively (apply CHAR_MAP and uppercase)
function aggressiveNormalize(raw) {
  return raw.split('').map(ch => CHAR_MAP[ch] || ch).join('').toUpperCase();
}

// Return array of all possible substrings length 16 from normalized text (sliding window)
function substringsOfLength16(norm) {
  const res = [];
  // keep only alphanum to slide (we keep letters too, we'll filter hex later)
  const alnum = norm.replace(/[^A-Za-z0-9]/g, '');
  if (alnum.length < 16) return res;
  for (let i = 0; i <= alnum.length - 16; i++) {
    res.push(alnum.slice(i, i + 16));
  }
  return res;
}

// hex purity: fraction of characters that are 0-9 A-F
function hexPurity(s) {
  if (!s || s.length === 0) return 0;
  let ok = 0;
  for (const ch of s) {
    if (/[0-9A-F]/.test(ch)) ok++;
  }
  return ok / s.length;
}

// Build candidate map from all OCR results: substring -> count
function buildSubstringVotes(ocrResults) {
  const map = new Map();
  for (const raw of ocrResults) {
    const norm = aggressiveNormalize(raw);
    // first, try to extract direct hex-like substrings (A-F0-9)
    const hexMatches = norm.match(/[A-F0-9]{12,}/g);
    if (hexMatches) {
      for (const m of hexMatches) {
        if (m.length === 16) {
          map.set(m, (map.get(m) || 0) + 3); // direct hex match gets more weight
        } else if (m.length > 16) {
          // slide windows across it
          for (let i = 0; i <= m.length - 16; i++) {
            const s = m.slice(i, i+16);
            map.set(s, (map.get(s) || 0) + 2);
          }
        } else {
          // length 12-15, include as lower weight substrings when padded later
          map.set(m, (map.get(m) || 0) + 1);
        }
      }
    }
    // Also add all sliding windows from full normalized (aggressive) string
    const substrs = substringsOfLength16(norm);
    for (const s of substrs) {
      map.set(s, (map.get(s) || 0) + 1);
    }
  }
  return map;
}

// Choose best candidate ordering by votes and hexPurity
function rankCandidatesByScore(map) {
  const arr = Array.from(map.entries()).map(([s,c]) => ({ s, c, purity: hexPurity(s) }));
  // score: prioritize count then purity
  arr.sort((a,b) => {
    const sa = a.c * 100 + Math.round(a.purity * 100);
    const sb = b.c * 100 + Math.round(b.purity * 100);
    return sb - sa;
  });
  return arr.map(x => x.s);
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

    // fetch image
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

    // Build substring votes
    const substrVotes = buildSubstringVotes(ocrResults);
    const ranked = rankCandidatesByScore(substrVotes);

    // Try ranked candidates -> validate via PlayFab or pick best purity if validation disabled
    for (const cand of ranked) {
      // ensure uppercase and remove non-alnum
      const candidate = cand.replace(/[^A-Za-z0-9]/g,'').toUpperCase();
      if (candidate.length !== 16) continue;
      // quick sanity: ensure most chars are hex
      if ((candidate.match(/[A-F0-9]/g) || []).length < 12) continue; // require at least 12 hex chars
      if (PLAYFAB_VALIDATE) {
        if (await tryValidatePlayFab(candidate)) {
          await message.channel.send(candidate);
          return;
        }
      } else {
        await message.channel.send(candidate);
        return;
      }
    }

    // If none validated, try variants from top-ranked items
    if (ranked.length > 0) {
      for (const base of ranked.slice(0, 6)) { // limit attempts
        const norm = base.replace(/[^A-Za-z0-9]/g,'').toUpperCase();
        // generate variants
        const vars = generateVariants(norm);
        for (const v of vars) {
          const candidate = v.replace(/[^A-Za-z0-9]/g,'').toUpperCase();
          if (candidate.length !== 16) continue;
          if ((candidate.match(/[A-F0-9]/g) || []).length < 12) continue;
          if (PLAYFAB_VALIDATE) {
            if (await tryValidatePlayFab(candidate)) {
              await message.channel.send(candidate);
              return;
            }
          } else {
            await message.channel.send(candidate);
            return;
          }
        }
      }
    }

    // Final heuristic fallback: attempt to take the substring with highest hex purity among all sliding windows across all normalized OCR strings
    let best = null;
    let bestScore = -1;
    for (const raw of ocrResults) {
      const norm = aggressiveNormalize(raw).replace(/[^A-Za-z0-9]/g,'').toUpperCase();
      for (let i = 0; i <= Math.max(0, norm.length - 16); i++) {
        const s = norm.slice(i, i+16);
        const purity = hexPurity(s);
        const score = purity * 100 + (substrVotes.get(s) || 0);
        if (score > bestScore) { bestScore = score; best = s; }
      }
    }
    if (best && best.length === 16 && (best.match(/[A-F0-9]/g) || []).length >= 10) {
      // if PlayFab enabled try validate, else send
      if (PLAYFAB_VALIDATE) {
        if (await tryValidatePlayFab(best)) {
          await message.channel.send(best);
          return;
        }
        // if validation fails, still don't spam wrong id; return not found
        await message.channel.send('❌ Failed to clearly read the ID (try a higher-contrast screenshot).');
        return;
      } else {
        await message.channel.send(best);
        return;
      }
    }

    // Nothing reliable found
    await message.channel.send('❌ Failed to clearly read the ID (try a higher-contrast screenshot).');
  } catch (err) {
    console.error('OCR handler error:', err);
  }
}
