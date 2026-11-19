import { IMAGE_LIMIT, outputFileName, type Job, type JobContext, type Result } from '../domain';
import { TEXT_LIMIT } from '../extra-tools';
import { inspectImage } from './image';

const textType = 'text/plain;charset=utf-8';

function resultFor(file: File, suffix: string, extension: string, blob: Blob, note?: string): Result {
  return { artifacts: [{ name: outputFileName(file, suffix, extension), blob }], note };
}

async function drawImage(file: File, maxSize: number, white: boolean) {
  await inspectImage(file);
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const graphics = canvas.getContext('2d', { willReadFrequently: true });
    if (!graphics) throw new Error('В этом браузере недоступно рисование в воркере.');
    if (white) {
      graphics.fillStyle = '#fff';
      graphics.fillRect(0, 0, width, height);
    }
    graphics.drawImage(bitmap, 0, 0, width, height);
    return { canvas, graphics, width, height };
  } finally {
    bitmap.close();
  }
}

async function imageForOcr(file: File) {
  const { canvas } = await drawImage(file, 3000, true);
  try {
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function imageTools(job: Job, context: JobContext): Promise<Result> {
  const { files, options, operation } = job;
  const file = files[0];
  if (files.length > 20 || files.reduce((bytes, input) => bytes + input.size, 0) > IMAGE_LIMIT) {
    throw new Error('За одну операцию можно выбрать до 20 изображений общим размером до 128 МБ.');
  }
  if (operation === 'image-invert') {
    const mime = options.imageFormat;
    const { canvas, graphics, width, height } = await drawImage(file, 16_384, mime === 'image/jpeg');
    try {
      const image = graphics.getImageData(0, 0, width, height);
      for (let i = 0; i < image.data.length; i += 4) {
        image.data[i] = 255 - image.data[i];
        image.data[i + 1] = 255 - image.data[i + 1];
        image.data[i + 2] = 255 - image.data[i + 2];
      }
      graphics.putImageData(image, 0, 0);
      const blob = await canvas.convertToBlob({ type: mime, quality: options.quality / 100 });
      if (blob.type !== mime) throw new Error('Браузер не поддерживает запись в выбранном формате.');
      return resultFor(file, 'inverted', mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1], blob);
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
  if (operation === 'image-pdf') {
    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.create();
    for (const [index, source] of files.entries()) {
      context.signal.throwIfAborted();
      const { canvas, width, height } = await drawImage(source, 4800, true);
      try {
        const bitmap = await pdf.embedJpg(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer());
        const base = options.paper === 'letter' ? [612, 792] : [595.28, 841.89];
        const size = options.paper === 'fit' ? [width, height].map((length) => length * Math.min(1, 1200 / Math.max(width, height)))
          : width > height ? base.reverse() : base;
        const page = pdf.addPage([size[0], size[1]]);
        const margin = options.paper === 'fit' ? 0 : 18;
        const scaled = bitmap.scaleToFit(page.getWidth() - margin * 2, page.getHeight() - margin * 2);
        page.drawImage(bitmap, {
          x: (page.getWidth() - scaled.width) / 2, y: (page.getHeight() - scaled.height) / 2,
          width: scaled.width, height: scaled.height,
        });
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
      context.progress('Добавляем изображения…', (index + 1) / files.length);
    }
    return resultFor(file, 'images', 'pdf', new Blob([new Uint8Array(await pdf.save())], { type: 'application/pdf' }));
  }

  const { recognizePages } = await import('./ocr');
  const sourceLanguage = options.translationDirection === 'en-ru' ? 'eng' : 'rus';
  // The UI passes the recognized text to the browser's local Translator instance.
  const language = operation === 'photo-translate' ? sourceLanguage : options.language;
  const text = await recognizePages(language, files.length, (index) => imageForOcr(files[index]), context,
    operation === 'batch-ocr' ? (index) => '— ' + files[index].name + ' —' : undefined, operation === 'image-xlsx');
  if (!text.trim()) throw new Error('На изображении не найден читаемый текст.');
  if (operation === 'image-docx') {
    const { docxBlob } = await import('./office');
    return resultFor(file, 'recognized', 'docx', docxBlob([text], options.paper === 'letter' ? 'letter' : 'a4'));
  }
  if (operation === 'image-xlsx') {
    const { rowsFromOcr, xlsxBlob } = await import('./tables');
    return resultFor(file, 'recognized', 'xlsx', xlsxBlob([{ name: 'Распознавание', rows: rowsFromOcr(text) }]),
      'Столбцы определены по пробелам и разделителям. Сверьте ячейки с изображением.');
  }
  return resultFor(file, 'recognized', 'txt', new Blob([text], { type: textType }));
}

async function statement(job: Job, context: JobContext): Promise<Result> {
  const { files: [file], options } = job;
  const { readCsv, csvBlob, xlsxBlob, statementRows } = await import('./tables');
  const source = /\.pdf$/i.test(file.name) ? (await (await import('./pdf-export')).extractPdfContent(file, options.pages, context)).rows
    : await readCsv(file, options.delimiter);
  const { rows, unparsed } = statementRows(source);
  if (rows.length < 2) throw new Error('Не найдено операций с датой, описанием и одной суммой. Проверьте справку по формату выписки и разделитель.');
  const note = 'Операций: ' + (rows.length - 1) + '. Строк для ручной проверки: ' + unparsed.length + '.';
  if (options.statementFormat === 'xlsx') {
    return resultFor(file, 'operations', 'xlsx', xlsxBlob([
      { name: 'Операции', rows },
      ...(unparsed.length ? [{ name: 'Проверить', rows: unparsed }] : []),
    ]), note);
  }
  const result = resultFor(file, 'operations', 'csv', csvBlob(rows, options.delimiter), note);
  if (unparsed.length) result.artifacts.push({
    name: outputFileName(file, 'review', 'csv'),
    blob: csvBlob(unparsed, options.delimiter),
  });
  return result;
}

export async function runExtended(job: Job, context: JobContext): Promise<Result> {
  const { operation, files: [file], options } = job;
  context.progress('Читаем исходные данные…', 0.05);
  if (['qr-generate', 'qr-scan', 'barcode-scan'].includes(operation)) {
    return (await import('./code')).processCode(job);
  }
  if (['image-invert', 'image-pdf', 'image-docx', 'image-xlsx', 'photo-translate', 'batch-ocr'].includes(operation)) {
    return imageTools(job, context);
  }
  if (operation === 'statement-export') return statement(job, context);
  if (operation === 'pdf-jpg') return (await import('./pdf-export')).pdfToJpeg(job, context);

  const paper = options.paper === 'letter' ? 'letter' : 'a4';
  if (operation === 'pdf-docx' || operation === 'pdf-html' || operation === 'pdf-csv' || operation === 'pdf-xlsx') {
    const { extractPdfContent } = await import('./pdf-export');
    const { sections, rows, pages } = await extractPdfContent(file, options.pages, context);
    if (operation === 'pdf-docx' || operation === 'pdf-html') {
      const { docxBlob, escapeMarkup } = await import('./office');
      if (operation === 'pdf-docx') return resultFor(file, 'text', 'docx', docxBlob(sections, paper));
      const html = '<!doctype html><html lang="ru"><meta charset="utf-8"><title>Экспорт PDF</title>' +
        sections.map((text, index) => '<section><h2>Страница ' + pages[index] + '</h2><pre>' + escapeMarkup(text) + '</pre></section>').join('') + '</html>';
      return resultFor(file, 'text', 'html', new Blob([html], { type: 'text/html;charset=utf-8' }));
    }
    const { xlsxBlob, csvBlob } = await import('./tables');
    const note = 'Столбцы восстановлены по расположению текста. Сверьте ячейки с PDF.';
    if (operation === 'pdf-xlsx') return resultFor(file, 'table', 'xlsx', xlsxBlob([{ name: 'Страницы', rows }]), note);
    return resultFor(file, 'table', 'csv', csvBlob(rows, options.delimiter), note);
  }

  if (operation === 'csv-xlsx') {
    const { readCsv, xlsxBlob } = await import('./tables');
    const rows = await readCsv(file, options.delimiter);
    return resultFor(file, 'table', 'xlsx', xlsxBlob([{ name: 'CSV', rows }]));
  }

  if (operation === 'xlsx-csv' || operation === 'xlsx-pdf' || operation === 'xlsx-jpg') {
    const { readWorkbook, csvBlob } = await import('./tables');
    const { rows, name } = await readWorkbook(file, options);
    if (operation === 'xlsx-csv') return resultFor(file, 'sheet', 'csv', csvBlob(rows, options.delimiter), 'Лист «' + name + '»');
    const { tablePages, exportPages } = await import('./layout');
    return { artifacts: await exportPages(file, tablePages(rows, paper), operation === 'xlsx-jpg' ? 'jpg' : 'pdf', context), note: 'Лист «' + name + '»' };
  }

  if (operation === 'docx-pdf' || operation === 'docx-jpg' || operation === 'docx-xlsx') {
    const { readDocx } = await import('./office');
    const { lines, tables } = await readDocx(file);
    if (operation === 'docx-xlsx') {
      const { xlsxBlob } = await import('./tables');
      const sheets = tables.length ? tables.map((rows, index) => ({ name: 'Таблица ' + (index + 1), rows }))
        : [{ name: 'Текст', rows: lines.map((line) => [line]) }];
      return resultFor(file, 'tables', 'xlsx', xlsxBlob(sheets));
    }
    const { textPages, exportPages } = await import('./layout');
    return { artifacts: await exportPages(file, textPages([lines.join('\n')], options), operation === 'docx-jpg' ? 'jpg' : 'pdf', context) };
  }

  if (operation === 'pptx-pdf') {
    const { readSlides } = await import('./office');
    const slides = await readSlides(file);
    const { textPages, exportPages } = await import('./layout');
    return { artifacts: await exportPages(file, textPages(slides.map((lines) => lines.join('\n')), options, true), 'pdf', context) };
  }

  if (file.size > TEXT_LIMIT) throw new Error('Текст или HTML должен занимать до 256 КБ.');
  let text = await file.text();
  if (operation === 'html-pdf') text = (await import('./office')).textFromHtml(text);
  if (!text.trim()) throw new Error('Добавьте текст для экспорта.');
  if (operation === 'text-docx') {
    const { docxBlob } = await import('./office');
    return resultFor(file, 'converted', 'docx', docxBlob([text], paper));
  }
  if (operation === 'text-pdf' || operation === 'text-image' || operation === 'html-pdf') {
    const { textPages, exportPages } = await import('./layout');
    return { artifacts: await exportPages(file, textPages([text], options), operation === 'text-image' ? 'png' : 'pdf', context) };
  }
  throw new Error('Инструмент не найден.');
}



