import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, type PDFPageProxy } from 'pdfjs-dist';
import { outputFileName, type Job, type JobContext } from '../domain';
import { checkPdfFiles, parsePages } from './pdf';

type CanvasRecord = { canvas: OffscreenCanvas | null; context: OffscreenCanvasRenderingContext2D | null };

class WorkerCanvasFactory {
  create(width: number, height: number): CanvasRecord {
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
  }
  reset({ canvas }: CanvasRecord, width: number, height: number) {
    if (!canvas) throw new Error('Canvas is unavailable.');
    canvas.width = width;
    canvas.height = height;
  }
  destroy(record: CanvasRecord) {
    this.reset(record, 0, 0);
    record.canvas = null;
    record.context = null;
  }
}

export async function withPdf<T>(file: File, action: (document: Awaited<ReturnType<typeof getDocument>['promise']>) => Promise<T>) {
  checkPdfFiles([file]);
  const base = new URL('/runtime/pdfjs/', self.location.origin);
  const worker = new Worker(new URL('worker.mjs', base), { type: 'module' });
  const initial = new Uint8Array(await file.slice(0, 65_536).arrayBuffer());
  let fail: (reason: unknown) => void = () => {};
  const readError = new Promise<never>((_, reject) => { fail = reject; });

  class LocalRanges extends PDFDataRangeTransport {
    #closed = false;
    requestDataRange(begin: number, end: number) {
      void file.slice(begin, end).arrayBuffer().then((data) => {
        if (!this.#closed) this.onDataRange(begin, new Uint8Array(data));
      }).catch(fail);
    }
    abort() {
      this.#closed = true;
    }
  }

  worker.addEventListener('error', () => fail(new Error('Не удалось запустить обработчик PDF.')));
  GlobalWorkerOptions.workerPort = worker;
  const loading = getDocument({
    range: new LocalRanges(file.size, initial),
    disableAutoFetch: true,
    disableStream: true,
    disableFontFace: true,
    disableWorkerRendering: true,
    useWorkerFetch: true,
    cMapUrl: new URL('cmaps/', base).href,
    standardFontDataUrl: new URL('standard_fonts/', base).href,
    wasmUrl: new URL('wasm/', base).href,
    iccUrl: new URL('iccs/', base).href,
    maxImageSize: 40_000_000,
    CanvasFactory: WorkerCanvasFactory,
  });

  try {
    return await Promise.race([loading.promise.then(action), readError]);
  } finally {
    try {
      await loading.destroy();
    } finally {
      worker.terminate();
      GlobalWorkerOptions.workerPort = null;
    }
  }
}

export async function rasterPdfPage(page: PDFPageProxy, scale: number, type: 'image/png' | 'image/jpeg', quality?: number) {
  const viewport = page.getViewport({ scale });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  if (width < 1 || height < 1 || width > 16_384 || height > 16_384 || width * height > 40_000_000) {
    throw new Error('Страница слишком велика для изображения. Уменьшите разрешение.');
  }
  const canvas = new OffscreenCanvas(width, height);
  try {
    const graphics = canvas.getContext('2d', { willReadFrequently: true });
    if (!graphics) throw new Error('Не удалось подготовить изображение страницы.');
    // PDF.js types its context as a DOM canvas. Its renderer also accepts OffscreenCanvas.
    await page.render({ canvas: null, canvasContext: graphics as unknown as CanvasRenderingContext2D, viewport, background: '#fff' }).promise;
    return await canvas.convertToBlob({ type, quality });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    page.cleanup();
  }
}

export function inspectPdf(file: File) {
  return withPdf(file, async (document) => ({ pages: document.numPages }));
}

export async function readPdf({ files: [file], operation, options }: Job, context: JobContext) {
  context.progress('Открываем PDF…');
  return withPdf(file, async (document) => {
    const isOcr = operation === 'pdf-ocr';
    const pages = parsePages(options.pages, document.numPages, !isOcr);
    if (isOcr && pages.length > 25) throw new Error('За одну операцию распознаётся до 25 страниц.');
    const heading = (number: number) => '— Страница ' + number + ' —';
    let hasText = false;
    let text: string;

    if (isOcr) {
      const { recognizePages } = await import('./ocr');
      text = await recognizePages(options.language, pages.length, async (index) => {
        const page = await document.getPage(pages[index]);
        const natural = page.getViewport({ scale: 1 });
        const scale = Math.min(2.6, 3000 / Math.max(natural.width, natural.height));
        return rasterPdfPage(page, scale, 'image/png');
      }, context, (index) => heading(pages[index]));
      hasText = !!text.replace(/— Страница \d+ —/g, '').trim();
    } else {
      const sections: string[] = [];
      for (const [index, number] of pages.entries()) {
        context.signal.throwIfAborted();
        const page = await document.getPage(number);
        const content = await page.getTextContent();
        const body = content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
        hasText ||= !!body;
        sections.push(heading(number) + '\n' + body);
        page.cleanup();
        context.progress('Извлекаем текст…', (index + 1) / pages.length);
      }
      text = sections.join('\n\n');
    }

    return {
      artifacts: [{ name: outputFileName(file, isOcr ? 'ocr' : 'text', 'txt'), blob: new Blob([text], { type: 'text/plain;charset=utf-8' }) }],
      note: hasText ? undefined : isOcr ? 'Модель не нашла читаемый текст.' : 'На выбранных страницах нет текстового слоя. Для сканов используйте распознавание.',
    };
  });
}


