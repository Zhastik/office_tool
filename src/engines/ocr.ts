import { createWorker } from 'tesseract.js';
import type { JobContext, Options } from '../domain';

export async function recognizePages(
  language: Options['language'],
  count: number,
  loadPage: (index: number) => Promise<Blob>,
  context: JobContext,
  pageLabel?: (index: number) => string,
  preserveSpacing = false,
) {
  const base = new URL('/runtime/ocr/', self.location.origin);
  let page = 0;
  context.progress('Загружаем модель распознавания…');
  const worker = await createWorker(language.split('+'), 1, {
    workerPath: new URL('worker.js', base).href,
    corePath: new URL('core', base).href,
    langPath: new URL('lang', base).href,
    workerBlobURL: false,
    logger: ({ status, progress }) => {
      if (status === 'recognizing text') {
        context.progress('Распознаём текст' + (count > 1 ? ' (' + (page + 1) + '/' + count + ')…' : '…'), (page + progress) / count);
      }
    },
  });

  const text: string[] = [];
  try {
    if (preserveSpacing) await worker.setParameters({ preserve_interword_spaces: '1' });
    for (; page < count; page++) {
      context.signal.throwIfAborted();
      const image = await loadPage(page);
      context.signal.throwIfAborted();
      const result = await worker.recognize(image);
      const content = result.data.text.trim();
      text.push(pageLabel ? pageLabel(page) + '\n' + content : content);
    }
    return text.join('\n\n');
  } finally {
    await worker.terminate();
  }
}


