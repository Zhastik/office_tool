import { outputFileName, type Job, type JobContext } from '../domain';
import { PDF_EXPORT_PAGE_LIMIT } from '../extra-tools';
import { parsePages } from './pdf';
import { rasterPdfPage, withPdf } from './pdf-reader';

export async function pdfToJpeg({ files: [file], options }: Job, context: JobContext) {
  return withPdf(file, async (document) => {
    const pages = parsePages(options.pages, document.numPages, true);
    if (pages.length > PDF_EXPORT_PAGE_LIMIT) throw new Error('Выберите до 25 страниц за одну операцию.');
    const artifacts = [];
    for (const [index, number] of pages.entries()) {
      context.signal.throwIfAborted();
      const page = await document.getPage(number);
      const dpi = Math.min(220, Math.max(72, options.dpi));
      const blob = await rasterPdfPage(page, dpi / 72, 'image/jpeg', options.quality / 100);
      artifacts.push({ name: outputFileName(file, 'page-' + number, 'jpg'), blob });
      context.progress('Рисуем страницы…', (index + 1) / pages.length);
    }
    return { artifacts };
  });
}

export async function extractPdfContent(file: File, range: string, context: JobContext) {
  return withPdf(file, async (document) => {
    const pages = parsePages(range, document.numPages, true);
    if (pages.length > 100) throw new Error('Выберите до 100 страниц за один экспорт текста.');
    const sections: string[] = [];
    const rows: string[][] = [];
    let characters = 0;
    for (const [index, number] of pages.entries()) {
      context.signal.throwIfAborted();
      const page = await document.getPage(number);
      const { items } = await page.getTextContent();
      const positioned = items.filter((item) => 'str' in item && item.str.trim()).map((item) => {
        if (!('str' in item)) throw new Error('Invalid PDF text item');
        return { text: item.str.trim(), x: item.transform[4], y: item.transform[5], width: item.width, height: item.height };
      }).sort((a, b) => b.y - a.y || a.x - b.x);

      const pageRows: string[][] = [];
      let at = 0;
      while (at < positioned.length) {
        const baseline = positioned[at].y;
        let end = at + 1;
        while (end < positioned.length && baseline - positioned[end].y <= 2.5) end++;
        const line = positioned.slice(at, end).sort((a, b) => a.x - b.x);
        const cells: string[] = [];
        let previousEnd = -Infinity;
        for (const part of line) {
          const gap = part.x - previousEnd;
          if (!cells.length || gap > Math.max(11, part.height * 0.9)) cells.push(part.text);
          else cells[cells.length - 1] += (gap > 1 ? ' ' : '') + part.text;
          previousEnd = Math.max(previousEnd, part.x + part.width);
          characters += part.text.length;
          if (characters > 1_000_000) throw new Error('Текстовый слой слишком велик. Выберите меньше страниц.');
        }
        if (cells.length) pageRows.push(cells);
        at = end;
      }
      sections.push(pageRows.map((row) => row.join('  ')).join('\n'));
      rows.push(...pageRows);
      page.cleanup();
      context.progress('Извлекаем текстовый слой…', (index + 1) / pages.length);
    }
    if (!rows.length) throw new Error('В выбранных страницах нет текстового слоя. Для скана используйте OCR.');
    return { sections, rows, pages };
  });
}


