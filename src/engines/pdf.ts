import { PDFArray, PDFDict, PDFDocument, PDFName, degrees } from 'pdf-lib';
import { PDF_LIMIT, fileSize, outputFileName, type Artifact, type Job, type JobContext } from '../domain';

const MAX_PARTS = 20;
const MAX_PAGES = 20_000;

export function checkPdfFiles(files: File[]) {
  if (files.some((file) => !file.size)) throw new Error('Один из файлов пуст.');
  if (files.reduce((sum, file) => sum + file.size, 0) > PDF_LIMIT) {
    throw new Error('Общий предел для PDF в этой версии — ' + fileSize(PDF_LIMIT) + '.');
  }
}

export function parsePages(value: string, count: number, emptyMeansAll = false) {
  if (!value.trim()) {
    if (emptyMeansAll) return Array.from({ length: count }, (_, index) => index + 1);
    throw new Error('Укажите номера страниц или диапазоны.');
  }
  const pages = new Set<number>();
  for (const part of value.split(',')) {
    const match = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(part.trim());
    if (!match) throw new Error('Используйте формат 1, 3–5, 8.');
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (start < 1 || end > count || start > end) throw new Error('Выберите диапазон от 1 до ' + count + '.');
    for (let number = start; number <= end; number++) {
      if (pages.has(number)) throw new Error('Страница ' + number + ' указана несколько раз.');
      pages.add(number);
    }
  }
  return [...pages];
}

async function openEditable(file: File) {
  const header = await file.slice(0, 1024).text();
  if (!header.includes('%PDF-')) throw new Error('Выберите действительный PDF-файл.');
  const document = await PDFDocument.load(await file.arrayBuffer(), { updateMetadata: false });
  const form = document.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = form?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (form?.has(PDFName.of('XFA')) || (fields && fields.size() > 0)) {
    throw new Error('Изменение страниц PDF с формами или полями электронной подписи пока недоступно. Можно извлечь текст.');
  }
  const count = document.getPageCount();
  if (!count || count > MAX_PAGES) throw new Error('Поддерживаются документы от 1 до 20 000 страниц.');
  return document;
}

async function buildSubset(source: PDFDocument, numbers: number[]) {
  const output = await PDFDocument.create();
  for (const page of await output.copyPages(source, numbers.map((number) => number - 1))) output.addPage(page);
  return output;
}

async function artifact(document: PDFDocument, file: File, suffix: string): Promise<Artifact> {
  const data = await document.save({ addDefaultPage: false, updateFieldAppearances: false });
  return { name: outputFileName(file, suffix, 'pdf'), blob: new Blob([new Uint8Array(data)], { type: 'application/pdf' }) };
}

export async function processPdf({ operation, files, options }: Job, context: JobContext) {
  checkPdfFiles(files);
  context.progress('Читаем PDF…', 0.08);
  const source = files[0];

  if (operation === 'pdf-merge') {
    if (files.length < 2) throw new Error('Выберите как минимум два PDF-файла.');
    const output = await PDFDocument.create();
    for (const [index, file] of files.entries()) {
      context.signal.throwIfAborted();
      const document = await openEditable(file);
      if (output.getPageCount() + document.getPageCount() > MAX_PAGES) throw new Error('Результат превышает лимит в 20 000 страниц.');
      for (const page of await output.copyPages(document, document.getPageIndices())) output.addPage(page);
      context.progress('Копируем страницы…', 0.1 + 0.7 * (index + 1) / files.length);
    }
    return { artifacts: [await artifact(output, source, 'merged')] };
  }

  const document = await openEditable(source);
  const count = document.getPageCount();

  if (operation === 'pdf-split') {
    const groups = options.pages.split(';');
    if (groups.length > MAX_PARTS) throw new Error('Укажите максимум ' + MAX_PARTS + ' частей за одну операцию.');
    const parsed = groups.map((group) => parsePages(group, count));
    const seen = new Set<number>();
    for (const page of parsed.flat()) {
      if (seen.has(page)) throw new Error('Диапазоны для разделения пересекаются на странице ' + page + '.');
      seen.add(page);
    }
    const artifacts: Artifact[] = [];
    let bytes = 0;
    for (const [index, pages] of parsed.entries()) {
      context.signal.throwIfAborted();
      const part = await artifact(await buildSubset(document, pages), source, 'part-' + (index + 1));
      bytes += part.blob.size;
      if (bytes > 2 * PDF_LIMIT) throw new Error('Суммарный размер частей слишком велик. Разделите документ за несколько операций.');
      artifacts.push(part);
      context.progress('Сохраняем части…', 0.15 + 0.8 * (index + 1) / parsed.length);
    }
    return { artifacts };
  }

  const pages = parsePages(options.pages, count, operation === 'pdf-rotate');
  context.progress('Обрабатываем страницы…', 0.45);
  if (operation === 'pdf-extract') {
    return { artifacts: [await artifact(await buildSubset(document, pages), source, 'pages')] };
  }
  if (operation === 'pdf-delete') {
    if (pages.length === count) throw new Error('Оставьте хотя бы одну страницу.');
    for (const number of pages.sort((a, b) => b - a)) document.removePage(number - 1);
  } else if (operation === 'pdf-rotate') {
    if (![90, 180, 270].includes(options.rotation)) throw new Error('Выберите угол поворота.');
    for (const number of pages) {
      const page = document.getPage(number - 1);
      page.setRotation(degrees((page.getRotation().angle + options.rotation) % 360));
    }
  } else if (operation === 'pdf-reorder') {
    if (pages.length !== count) throw new Error('Укажите все страницы документа в новом порядке.');
    const original = document.getPages().slice();
    for (let index = count - 1; index >= 0; index--) document.removePage(index);
    for (const number of pages) document.addPage(original[number - 1]);
  } else {
    throw new Error('Неизвестная операция PDF.');
  }
  context.progress('Сохраняем PDF…', 0.85);
  return { artifacts: [await artifact(document, source, 'edited')] };
}

