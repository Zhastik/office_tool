import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { chromium } from 'playwright-core';
import XLSX from 'xlsx';

const origin = new URL(process.env.PDFWORK_URL || 'http://127.0.0.1:8765').origin;
const scratch = await mkdtemp(join(tmpdir(), 'pdfwork-tools-'));
const browserPath = process.env.PDFWORK_BROWSER_EXECUTABLE;
let browser;
const diagnostics = [];
const requests = [];
const fixture = (name, mimeType, buffer) => ({ name, mimeType, buffer: Buffer.from(buffer) });

async function pdfFixture() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([595, 842]);
  const records = [
    ['Date', 'Description', 'Amount'],
    ['2026-11-21', 'Local test', '-12.50'],
    ['2026-11-22', 'Subscription', '120.00'],
  ];
  for (const [row, cells] of records.entries()) {
    for (const [column, text] of cells.entries()) {
      page.drawText(text, { x: [36, 170, 405][column], y: 747 - 26 * row, size: 15, font });
    }
  }
  return fixture('table.pdf', 'application/pdf', await document.save());
}

function presentationFixture() {
  const slide = (text) => strToU8('<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>' + text + '</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>');
  return fixture('slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zipSync({
    'ppt/presentation.xml': strToU8('<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="two"/><p:sldId r:id="one"/></p:sldIdLst></p:presentation>'),
    'ppt/_rels/presentation.xml.rels': strToU8('<Relationships><Relationship Id="one" Target="slides/slide1.xml"/><Relationship Id="two" Target="slides/slide2.xml"/></Relationships>'),
    'ppt/slides/slide1.xml': slide('Другой слайд'),
    'ppt/slides/slide2.xml': slide('Первый слайд'),
  }));
}

function sheetRows(buffer, sheet = 0) {
  const book = XLSX.read(buffer, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[sheet]], { header: 1, defval: '' });
}

try {
  browser = await chromium.launch(browserPath ? { executablePath: browserPath } : { channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  context.on('request', (request) => requests.push({ url: request.url(), method: request.method(), body: request.postData() }));
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => diagnostics.push(error.stack || String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.push(message.text());
  });
  await page.goto(origin);
  await page.getByRole('heading', { name: 'Инструменты для файлов' }).waitFor();
  const source = await page.evaluate(() => {
    const toImage = (width, height, draw) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      draw(ctx);
      return canvas.toDataURL().split(',')[1];
    };

    const image = toImage(700, 240, (ctx) => {
      ctx.fillStyle = '#000';
      ctx.font = 'bold 52px Arial';
      ctx.fillText('LOCAL FILE TEST', 42, 100);
    });

    const barcode = toImage(460, 126, (ctx) => {
      const patterns = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
      const invert = (bits) => bits.replace(/[01]/g, (bit) => bit === '0' ? '1' : '0');
      const value = '4006381333931';
      let bits = '101';
      for (let i = 1; i <= 6; i++) {
        const pattern = patterns[Number(value[i])];
        bits += 'LGLLGG'[i - 1] === 'L' ? pattern : invert(pattern).split('').reverse().join('');
      }
      bits += '01010';
      for (let i = 7; i < 13; i++) bits += invert(patterns[Number(value[i])]);
      bits += '101';
      ctx.fillStyle = '#000';
      [...bits].forEach((bit, i) => { if (bit === '1') ctx.fillRect(40 + i * 4, 12, 4, 94); });
    });

    return { image, barcode };
  });
  const photo = fixture('photo.png', 'image/png', Buffer.from(source.image, 'base64'));
  const barcode = fixture('barcode.png', 'image/png', Buffer.from(source.barcode, 'base64'));
  const pdf = await pdfFixture();
  const task = page.getByRole('region', { name: 'Результат' });
  const search = page.getByRole('searchbox', { name: 'Найти инструмент' });

  async function tool(name, input) {
    const button = page.getByRole('button', { name, exact: true });
    if (!await button.count()) await search.fill(name);
    await button.click();
    assert.match(await page.getByRole('complementary', { name: 'Справка по настройкам' }).innerText(), /Допустимые настройки/);
    if (input) {
      const previous = page.getByRole('button', { name: /^Убрать / });
      while (await previous.count()) await previous.first().click();
      await page.locator('input[type=file]').setInputFiles(input);
    }
  }
  const field = (label) => page.getByLabel(label, { exact: true });
  const select = (label, value) => field(label).selectOption(value);
  const fill = (label, value) => field(label).fill(value);
  const launch = page.getByRole('button', { name: 'Запустить обработку' });

  async function go(name) {
    console.log(name);
    const alert = page.getByRole('alert');
    await launch.click();
    await task.or(alert).first().waitFor({ timeout: 90_000 });
    if (await alert.count()) throw new Error(await alert.first().innerText());
  }
  async function download(index = 0) {
    const pending = page.waitForEvent('download');
    await task.getByRole('link').nth(index).click();
    const item = await pending;
    const path = join(scratch, item.suggestedFilename());
    await item.saveAs(path);
    return readFile(path);
  }
  async function checkPdf(bytes, count = 1) {
    assert.equal((await PDFDocument.load(bytes)).getPageCount(), count);
  }

  await page.getByRole('button', { name: 'Все инструменты' }).click();
  assert.equal(await page.locator('.catalog-grid .operation').count(), 43);
  assert.ok(await page.getByRole('button', { name: 'Обрезать видео', exact: true }).isVisible());
  if (process.env.PDFWORK_CATALOG_SCREENSHOT) await page.screenshot({ path: process.env.PDFWORK_CATALOG_SCREENSHOT });

  await tool('PDF в JPG', pdf);
  await fill('Страницы для JPG', '1');
  await fill('Разрешение JPG, dpi', '72');
  assert.match(await page.getByRole('complementary', { name: 'Справка по настройкам' }).innerText(), /72–220 dpi/);
  if (process.env.PDFWORK_GUIDE_SCREENSHOT) await page.screenshot({ path: process.env.PDFWORK_GUIDE_SCREENSHOT });
  await go('PDF → JPG'); assert.equal((await download()).readUInt16BE(0), 0xffd8);

  await tool('PDF в Word', pdf);
  await go('PDF → DOCX'); assert.match(strFromU8(unzipSync(await download())['word/document.xml']), /Local test/);
  await tool('PDF в HTML', pdf);
  await go('PDF → HTML'); assert.match((await download()).toString('utf8'), /<pre>[\s\S]*Local test/);
  await tool('PDF в CSV', pdf);
  await go('PDF → CSV'); assert.match((await download()).toString('utf8'), /"Date";"Description";"Amount"/);
  await tool('PDF в Excel', pdf);
  await go('PDF → XLSX'); assert.deepEqual(sheetRows(await download())[1], ['2026-11-21', 'Local test', '-12.50']);

  const text = 'Проверка кириллицы\nLOCAL FILE TEST';
  await tool('Текст в PDF');
  await fill('Исходный текст', text);
  await fill('Размер текста, пт', '15');
  await go('Text → PDF');
  const encodedPdf = await download();
  await checkPdf(encodedPdf);

  await tool('Текст в изображение');
  await fill('Исходный текст', text);
  await go('Text → PNG'); assert.equal((await download()).subarray(1,4).toString('ascii'), 'PNG');
  await tool('Текст в Word');
  await fill('Исходный текст', text);
  await go('Text → DOCX');
  const wordArchive = unzipSync(await download());
  assert.match(strFromU8(wordArchive['word/document.xml']), /Проверка кириллицы/);
  const row = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Код</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>012</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
  wordArchive['word/document.xml'] = strToU8(strFromU8(wordArchive['word/document.xml']).replace('<w:sectPr>', row + '<w:sectPr>'));
  const word = fixture('word.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', zipSync(wordArchive));

  await tool('Word в PDF', word);
  await go('DOCX → PDF'); await checkPdf(await download());
  await tool('Word в JPG', word);
  await go('DOCX → JPG'); assert.equal((await download()).readUInt16BE(0), 0xffd8);
  await tool('Word в Excel', word);
  await go('DOCX → XLSX'); assert.deepEqual(sheetRows(await download())[0], ['Код', '012']);
  await tool('PowerPoint в PDF', presentationFixture());
  await go('PPTX → PDF'); await checkPdf(await download(), 2);
  await tool('HTML в PDF');
  await fill('Исходный HTML', '<h1>Рабочий документ</h1><p>Строка</p><img src="https://example.com/image.png"><script>IGNORE ME</script>');
  await go('HTML → PDF'); await checkPdf(await download());

  await tool('Инвертировать цвета', photo);
  await select('Формат результата', 'image/png');
  await go('Image invert'); assert.equal((await download()).subarray(1,4).toString('ascii'), 'PNG');
  await tool('Изображения в PDF', [photo, photo]);
  await select('Формат страницы', 'fit');
  await go('Images → PDF'); await checkPdf(await download(), 2);
  await tool('Фото в Word', photo);
  await select('Язык документа', 'eng');
  await go('Photo OCR → DOCX');
  assert.match(strFromU8(unzipSync(await download())['word/document.xml']), /LOCAL FILE TEST/);
  await tool('Фото в Excel', photo);
  await select('Язык документа', 'eng');
  await go('Photo OCR → XLSX');
  assert.deepEqual(sheetRows(await download())[0], ['LOCAL FILE TEST']);
  await tool('Пакетное OCR', [photo, { ...photo, name: 'second.png' }]);
  await select('Язык документа', 'eng');
  await go('Batch OCR');
  assert.match((await download()).toString('utf8'), /photo.png[\s\S]*LOCAL FILE TEST[\s\S]*second.png[\s\S]*LOCAL FILE TEST/);

  const csv = fixture('table.csv', 'text/csv', 'name;id\nAlice;001\nBob;002');
  await tool('CSV в Excel', csv);
  await go('CSV → XLSX');
  const excel = fixture('table.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', await download());
  assert.deepEqual(sheetRows(excel.buffer)[1], ['Alice', '001']);
  await tool('Excel в CSV', excel);
  await fill('Диапазон ячеек', 'B2:B3');
  await go('XLSX → CSV'); assert.match((await download()).toString('utf8'), /"001"\r\n"002"/);
  await tool('Excel в PDF', excel);
  await go('XLSX → PDF'); await checkPdf(await download());
  await tool('Excel в JPG', excel);
  await go('XLSX → JPG'); assert.equal((await download()).readUInt16BE(0), 0xffd8);

  const statement = fixture('statement.csv', 'text/csv', 'Дата;Описание;Сумма\n21.11.2026;Покупка;-1250,50\n22.11.2026;Непонятная строка;—');
  await tool('Банковская выписка', statement);
  await go('Statement → XLSX');
  const operations = await download();
  assert.deepEqual(sheetRows(operations)[1], ['21.11.2026', 'Покупка', '-1250.50']);
  assert.equal(sheetRows(operations, 1)[0][1], 'Непонятная строка');
  await page.locator('input[type=file]').setInputFiles(pdf);
  await select('Формат выписки', 'csv');
  await go('PDF statement → CSV'); assert.match((await download()).toString(), /"2026-11-21";"Local test";"-12.50"/);

  await tool('Создать QR-код');
  const value = 'https://example.com/тест';
  await fill('Текст или ссылка', value);
  await select('Размер QR-кода', '256');
  await select('Коррекция ошибок', 'H');
  await go('QR generate');
  assert.equal(await task.getByAltText('Созданный QR-код').count(), 1);
  const qr = fixture('qr.png', 'image/png', await download());
  assert.equal(qr.buffer.readUInt32BE(16), 256);
  await tool('Прочитать QR-код', qr);
  await go('QR scan');
  assert.equal((await download()).toString('utf8'), value);
  await tool('Прочитать штрихкод', barcode);
  await go('Barcode scan');
  assert.equal((await download()).toString('utf8'), '4006381333931');

  const model = await page.evaluate(async () => {
    try { return await window.Translator?.availability({ sourceLanguage: 'en', targetLanguage: 'ru' }); }
    catch { return 'unavailable'; }
  });
  if (model !== 'available') {
    await page.evaluate(() => Object.defineProperty(window, 'Translator', {
      configurable: true,
      value: {
        availability: async () => 'available',
        create: async ({ sourceLanguage, targetLanguage }) => ({
          translate: async (input) => {
            if (sourceLanguage !== 'en' || targetLanguage !== 'ru' || !input.includes('LOCAL FILE TEST')) throw new Error('Wrong translation input');
            return 'Проверка локального перевода';
          },
          destroy() {},
        }),
      },
    }));
  }
  await tool('Перевести фото', photo);
  await go('Photo OCR → browser Translator (' + (model === 'available' ? 'native model' : 'contract double; native: ' + (model ?? 'missing')) + ')');
  assert.match((await download()).toString('utf8'), /[А-Яа-я]/);

  await tool('Извлечь текст из PDF', fixture('text-export.pdf', 'application/pdf', encodedPdf));
  await go('Selectable Cyrillic PDF round trip');
  assert.match((await download()).toString('utf8'), /Проверка кириллицы/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Все инструменты' }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  for (const request of requests) {
    const url = new URL(request.url);
    if (!/^https?:$/.test(url.protocol)) continue;
    assert.equal(url.origin, origin);
    assert.equal(request.method, 'GET');
    assert.equal(request.body, null);
    assert.equal(url.search, '');
    assert.match(url.pathname, /^\/(?:$|assets\/|runtime\/|favicon\.svg$)/);
  }
  console.log('Verified 27 new tools, catalog, setting guides, responsive layout and local-only requests.');
} catch (error) {
  for (const message of diagnostics) console.error(message);
  throw error;
} finally {
  await browser?.close();
  if (dirname(resolve(scratch)) === resolve(tmpdir()) && basename(scratch).startsWith('pdfwork-tools-')) {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}




