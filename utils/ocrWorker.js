// utils/ocrWorker.js
import { createWorker } from 'tesseract.js';

let workerPromise = null;

export async function getOcrWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = createWorker({
        // logger: m => console.log('[tesseract]', m) // odkomentuj do debugu
      });
      await worker.load();
      await worker.loadLanguage('eng');
      await worker.initialize('eng');
      // opcjonalne parametry:
      // await worker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' });
      return worker;
    })();
  }
  return workerPromise;
}

export async function recognizeImageBuffer(buffer) {
  const worker = await getOcrWorker();
  const { data: { text } } = await worker.recognize(buffer);
  return text;
}
