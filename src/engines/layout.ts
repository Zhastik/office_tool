import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import fontUrl from '../fonts/NotoSans-Regular.ttf?url';
import { outputFileName, type Artifact, type JobContext, type Options } from '../domain';

interface Label { x: number; y: number; text: string; size: number }
interface Box { x: number; y: number; width: number; height: number; header: boolean }
interface Page { width: number; height: number; labels: Label[]; boxes: Box[] }

const margin = 38;
const pageLimit = 50;
const rasterPageLimit = 25;
let fontBytes: Promise<ArrayBuffer> | undefined;

function loadFont() {
  return fontBytes ??= fetch(fontUrl).then((response) => {
    if (!response.ok) throw new Error('Не удалось загрузить шрифт экспорта.');
    return response.arrayBuffer();
  });
}

function dimensions(paper: Options['paper']) {
  return paper === 'letter' ? [612, 792] : [595.28, 841.89];
}

function wrap(text: string, columns: number) {
  const output: string[] = [];
  for (const source of text.replace(/\t/g, '    ').split(/\r\n?|\n/)) {
    const characters = Array.from(source);
    let start = 0;
    while (characters.length - start > columns) {
      const chunk = characters.slice(start, start + columns);
      const space = chunk.lastIndexOf(' ');
      const cut = space > columns / 3 ? space + 1 : columns;
      output.push(chunk.slice(0, cut).join('').trimEnd());
      start += cut;
    }
    output.push(characters.slice(start).join(''));
  }
  return output;
}

export function textPages(sections: string[], options: Options, slides = false): Page[] {
  if (!sections.some((section) => section.trim())) throw new Error('Добавьте текст для экспорта.');
  const [width, height] = slides ? [792, 446] : dimensions(options.paper);
  const size = Math.max(9, Math.min(28, options.fontSize));
  const columns = Math.max(12, Math.floor((width - margin * 2) / (size * 0.8)));
  const capacity = Math.floor((height - margin * 2) / (size * 1.5)) - (slides ? 2 : 0);
  const pages: Page[] = [];
  for (const [index, section] of sections.entries()) {
    const lines = wrap(section, columns);
    for (let offset = 0; offset < lines.length; offset += capacity) {
      if (pages.length >= pageLimit) throw new Error('Документ превысит 50 страниц. Сократите исходный текст или уменьшите размер шрифта.');
      const labels = lines.slice(offset, offset + capacity).map((text, line) => ({
        x: margin, y: margin + size + (line + (slides ? 2 : 0)) * size * 1.5, text, size,
      }));
      if (slides) labels.unshift({ x: margin, y: margin + size, size, text: 'Слайд ' + (index + 1) });
      pages.push({ width, height, labels, boxes: [] });
    }
  }
  return pages;
}

export function tablePages(rows: string[][], paper: Options['paper']): Page[] {
  const base = dimensions(paper);
  const [height, width] = base;
  const size = 10;
  const count = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const cap = 6;
  const pages: Page[] = [];
  for (let col = 0; col < count; col += cap) {
    const columnCount = Math.min(cap, count - col);
    const cellWidth = (width - 2 * margin) / columnCount;
    const maxChars = Math.floor((cellWidth - 12) / (size * 0.8));
    let page: Page | undefined;
    let y = 0;
    for (const [index, row] of rows.entries()) {
      const cells = Array.from({ length: columnCount }, (_, i) => wrap(row[col + i] ?? '', maxChars));
      const rowHeight = Math.max(...cells.map((cell) => cell.length)) * 14 + 10;
      if (rowHeight > height - 2 * margin) throw new Error('Одна из ячеек слишком велика для страницы. Выберите другой диапазон.');
      if (!page || y + rowHeight > height - margin) {
        if (pages.length >= pageLimit) throw new Error('Таблица превысит 50 страниц. Ограничьте диапазон ячеек.');
        page = { width, height, labels: [], boxes: [] };
        pages.push(page);
        y = margin;
      }
      for (const [column, lines] of cells.entries()) {
        const x = margin + column * cellWidth;
        page.boxes.push({ x, y, width: cellWidth, height: rowHeight, header: index === 0 });
        page.labels.push(...lines.map((text, line) => ({ x: x + 6, y: y + 15 + line * 14, text, size })));
      }
      y += rowHeight;
    }
  }
  return pages;
}

export async function exportPages(file: File, pages: Page[], format: 'pdf' | 'jpg' | 'png', context: JobContext): Promise<Artifact[]> {
  context.progress('Готовим страницы…', 0.1);
  const bytes = await loadFont();
  if (format === 'pdf') {
    const document = await PDFDocument.create();
    document.registerFontkit(fontkit);
    const font = await document.embedFont(bytes, { subset: true });
    const glyphs = new Set(font.getCharacterSet());
    for (const config of pages) {
      context.signal.throwIfAborted();
      const page = document.addPage([config.width, config.height]);
      for (const box of config.boxes) {
        page.drawRectangle({ x: box.x, y: config.height - box.y - box.height, width: box.width, height: box.height,
          borderColor: rgb(0.78, 0.8, 0.86), borderWidth: 0.55, color: box.header ? rgb(0.94, 0.93, 0.99) : rgb(1, 1, 1) });
      }
      for (const item of config.labels) {
        const text = Array.from(item.text, (character) => glyphs.has(character.codePointAt(0)!) ? character : '?').join('');
        page.drawText(text, { x: item.x, y: config.height - item.y, size: item.size, font, color: rgb(0.14, 0.15, 0.21) });
      }
    }
    return [{ name: outputFileName(file, 'converted', 'pdf'), blob: new Blob([new Uint8Array(await document.save())], { type: 'application/pdf' }) }];
  }

  if (pages.length > rasterPageLimit) throw new Error('За одну операцию можно сохранить до 25 изображений. Сократите текст или диапазон.');
  const font = await new FontFace('PDFworkExport', bytes).load();
  (self as unknown as DedicatedWorkerGlobalScope).fonts.add(font);
  try {
    const outputs: Artifact[] = [];
    for (const [index, page] of pages.entries()) {
      context.signal.throwIfAborted();
      const canvas = new OffscreenCanvas(Math.ceil(page.width * 2), Math.ceil(page.height * 2));
      const graphics = canvas.getContext('2d');
      if (!graphics) throw new Error('Не удалось подготовить изображение страницы.');
      try {
        graphics.scale(2, 2);
        graphics.fillStyle = '#fff';
        graphics.fillRect(0, 0, page.width, page.height);
        for (const box of page.boxes) {
          graphics.fillStyle = box.header ? '#efedfc' : '#fff';
          graphics.fillRect(box.x, box.y, box.width, box.height);
          graphics.strokeStyle = '#c8ccda';
          graphics.lineWidth = 0.6;
          graphics.strokeRect(box.x, box.y, box.width, box.height);
        }
        graphics.fillStyle = '#252636';
        for (const label of page.labels) {
          graphics.font = label.size + 'px PDFworkExport';
          graphics.fillText(label.text, label.x, label.y);
        }
        const blob = await canvas.convertToBlob({ type: format === 'jpg' ? 'image/jpeg' : 'image/png', quality: 0.88 });
        outputs.push({ name: outputFileName(file, 'page-' + (index + 1), format), blob });
        context.progress('Кодируем страницы…', (index + 1) / pages.length);
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    return outputs;
  } finally {
    (self as unknown as DedicatedWorkerGlobalScope).fonts.delete(font);
  }
}

