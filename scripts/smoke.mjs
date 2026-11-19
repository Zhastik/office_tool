import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { chromium } from 'playwright-core';

const origin = new URL(process.env.PDFWORK_URL || 'http://127.0.0.1:8765').origin;
const scratch = await mkdtemp(join(tmpdir(), 'pdfwork-smoke-'));
const diagnostics = [];
const network = [];
let browser;
let context;

function ff(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function makePdf(path, widths, png) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const image = png && await document.embedPng(png);
  for (const width of widths) {
    const page = document.addPage([width, 230]);
    if (image) page.drawImage(image, { x: 8, y: 8, width: width - 16, height: 210 });
    else page.drawText('LOCAL FILE TEST', { x: 20, y: 110, size: 20, font });
  }
  await writeFile(path, await document.save());
}

async function outputWidths(path) {
  return (await PDFDocument.load(await readFile(path))).getPages().map((page) => page.getWidth());
}

try {
  const health = await fetch(origin + '/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).file_processing, 'browser');
  assert.equal((await fetch(origin + '/api/health', { method: 'POST', body: 'smoke-fixture' })).status, 405);

  const executablePath = process.env.PDFWORK_BROWSER_EXECUTABLE;
  const launchOptions = executablePath ? { executablePath } : { channel: 'chrome' };
  const contextOptions = { viewport: { width: 1366, height: 850 } };
  if (process.env.PDFWORK_LARGE_MEDIA === '1') {
    context = await chromium.launchPersistentContext(join(scratch, 'browser-profile'), { ...launchOptions, ...contextOptions });
  } else {
    browser = await chromium.launch(launchOptions);
    context = await browser.newContext(contextOptions);
  }
  const fixtures = await context.newPage();
  const png = Buffer.from(await fixtures.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 700;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    ctx.font = 'bold 48px Arial';
    ctx.fillText('LOCAL FILE TEST', 48, 95);
    ctx.fillText('ПРОВЕРКА', 48, 172);
    return canvas.toDataURL().split(',')[1];
  }), 'base64');
  await fixtures.close();

  const a = join(scratch, 'a.pdf');
  const b = join(scratch, 'b.pdf');
  const scan = join(scratch, 'scan.pdf');
  const picture = join(scratch, 'picture.png');
  const audio = join(scratch, 'audio.wav');
  const video = join(scratch, 'video.mp4');
  await Promise.all([makePdf(a, [320, 330, 340]), makePdf(b, [420]), makePdf(scan, [650], png), writeFile(picture, png)]);
  ff('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=550:r=48000:d=4', audio]);
  ff('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=6',
    '-f', 'lavfi', '-i', 'sine=f=660:r=48000:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-g', '24', '-keyint_min', '24', '-sc_threshold', '0', '-c:a', 'aac', '-movflags', '+faststart', video,
  ]);

  context.on('request', (request) => network.push({
    url: request.url(), method: request.method(), payload: request.postData(),
  }));

  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => diagnostics.push(error.stack ?? String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') diagnostics.push(message.text());
  });

  await page.goto(origin + '/');
  await page.getByRole('heading', { name: 'Инструменты для файлов' }).waitFor();
  if (process.env.PDFWORK_SCREENSHOT) await page.screenshot({ path: process.env.PDFWORK_SCREENSHOT });

  const mode = (label) => page.getByRole('button', { name: label, exact: true }).click();
  const inputs = (paths) => page.locator('input[type=file]').setInputFiles(paths);
  const fill = (label, value) => page.getByLabel(label, { exact: false }).fill(value);
  const select = (label, value) => page.getByLabel(label, { exact: false }).selectOption(value);
  const task = page.getByRole('region', { name: 'Результат' });
  const go = async (step, timeout = 90_000) => {
    console.log(step);
    const button = page.getByRole('button', { name: 'Запустить обработку' });
    const alert = page.getByRole('alert');
    if (await alert.count()) throw new Error(await alert.first().innerText());
    await button.click();
    await task.or(alert).first().waitFor({ timeout });
    if (await alert.count()) throw new Error(await alert.first().innerText());
    return task;
  };
  async function download(index = 0) {
    const pending = page.waitForEvent('download');
    await task.getByRole('link').nth(index).click();
    const file = await pending;
    const path = join(scratch, file.suggestedFilename());
    await file.saveAs(path);
    return path;
  }

  await inputs([a, b]);
  await page.getByRole('button', { name: 'Поднять b.pdf' }).click();
  await go('PDF merge, ordered input');
  assert.deepEqual(await outputWidths(await download()), [420, 320, 330, 340]);

  await mode('Разделить');
  await inputs(a);
  await fill('Диапазоны для частей', '1; 2–3');
  await go('PDF split');
  assert.deepEqual(await outputWidths(await download(0)), [320]);
  assert.deepEqual(await outputWidths(await download(1)), [330, 340]);

  for (const [label, field, ranges, expected] of [
    ['Извлечь страницы', 'Номера страниц', '3,1', [340, 320]],
    ['Удалить страницы', 'Страницы для удаления', '2', [320, 340]],
    ['Изменить порядок', 'Новый порядок', '3,1,2', [340, 320, 330]],
  ]) {
    await mode(label);
    await fill(field, ranges);
    await go('PDF ' + label);
    assert.deepEqual(await outputWidths(await download()), expected);
  }

  await mode('Повернуть');
  await fill('Страницы для поворота', '2');
  await go('PDF rotate');
  const rotated = await PDFDocument.load(await readFile(await download()));
  assert.deepEqual(rotated.getPages().map((item) => item.getRotation().angle), [0, 90, 0]);

  await mode('Извлечь текст');
  await go('PDF text');
  assert.match(await readFile(await download(), 'utf8'), /LOCAL FILE TEST/);

  await mode('Распознать скан');
  await inputs(scan);
  await go('Scanned PDF OCR');
  assert.match(await readFile(await download(), 'utf8'), /LOCAL FILE TEST/);

  await mode('Изображения');
  await inputs(picture);
  await go('Image convert');
  assert.equal((await readFile(await download())).toString('ascii', 8, 12), 'WEBP');

  await mode('Размер');
  await fill('Ширина, px', '350');
  await select('Формат результата', 'image/png');
  await go('Image resize');
  const resized = await readFile(await download());
  assert.equal(resized.readUInt32BE(16), 350);
  assert.equal(resized.readUInt32BE(20), 120);

  await mode('Сжать');
  await select('Формат результата', 'image/jpeg');
  await go('Image compress');
  assert.equal((await readFile(await download())).readUInt16BE(0), 0xffd8);

  await mode('Распознать текст');
  await go('Image OCR');
  const recognized = await readFile(await download(), 'utf8');
  assert.match(recognized, /LOCAL FILE TEST/);
  assert.match(recognized, /ПРОВЕРКА/);

  await mode('Аудио');
  await inputs(audio);
  await select('Формат результата', 'opus');
  await go('Audio conversion');
  assert.equal((await readFile(await download())).toString('ascii', 0, 4), 'OggS');

  await mode('Обрезать');
  await fill('Начало', '1.25');
  await fill('Конец', '2.75');
  await go('Audio trim & WAV');
  const clip = await download();
  const seconds = Number(ff('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clip]));
  assert.ok(Math.abs(seconds - 1.5) < 0.04, 'WAV duration ' + seconds);

  const probe = (path) => JSON.parse(ff('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,height', '-of', 'json', path]));
  await mode('Видео');
  await inputs(video);
  await fill('Начало', '1.2');
  await fill('Конец', '4.8');
  await go('Video copy trim');
  const trim = probe(await download());
  assert.deepEqual(trim.streams.map((stream) => stream.codec_name), ['h264', 'aac']);
  assert.ok(Number(trim.format.duration) > 1 && Number(trim.format.duration) < 4, 'MP4 clip duration ' + trim.format.duration);

  await mode('Сжать');
  if (process.env.PDFWORK_SMOKE_WEBM_ONLY !== '1') {
    await go('Video compression');
    const compressed = probe(await download());
    assert.deepEqual(compressed.streams.map((stream) => stream.codec_name), ['h264', 'aac']);
    assert.equal(compressed.streams[0].height, 180);
  }

  await select('Формат результата', 'webm');
  await go('Video compression with WebM');
  assert.deepEqual(probe(await download()).streams.map((stream) => stream.codec_name), ['vp8', 'opus']);

  await page.evaluate(() => {
    window.showSaveFilePicker = async () => (await navigator.storage.getDirectory())
      .getFileHandle('direct-write.mp4', { create: true });
  });
  await mode('Обрезать');
  await fill('Начало', '1.2');
  await fill('Конец', '4.8');
  await page.getByLabel('Сохранять сразу на диск').check();
  await go('Video direct disk writer (OPFS file handle)');
  assert.match(await task.innerText(), /Файл сохранён/);
  const written = await page.evaluate(async () => {
    const directory = await navigator.storage.getDirectory();
    const output = await (await directory.getFileHandle('direct-write.mp4')).getFile();
    return [...new Uint8Array(await output.arrayBuffer())];
  });
  const saved = join(scratch, 'direct-write.mp4');
  await writeFile(saved, Buffer.from(written));
  assert.deepEqual(probe(saved).streams.map((stream) => stream.codec_name), ['h264', 'aac']);

  if (process.env.PDFWORK_LARGE_MEDIA === '1') {
    const seedTs = join(scratch, 'seed.ts');
    const seed = join(scratch, 'seed.mp4');
    const large = join(scratch, 'large.mp4');
    console.log('Generating synthetic 5 GiB MP4. OPFS quota:', await page.evaluate(() => navigator.storage.estimate()));
    ff('ffmpeg', [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=960x540:r=30:d=5',
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-g', '30',
      '-b:v', '20M', '-minrate', '20M', '-maxrate', '20M', '-bufsize', '20M',
      '-x264-params', 'nal-hrd=cbr:force-cfr=1', seedTs,
    ]);
    ff('ffmpeg', ['-y', '-v', 'error', '-i', seedTs, '-map', '0:v:0', '-c', 'copy', seed]);
    const repetitions = Math.ceil(5 * 1024 ** 3 / (await stat(seed)).size) + 1;
    ff('ffmpeg', ['-y', '-v', 'error', '-stream_loop', String(repetitions), '-i', seed, '-map', '0:v:0', '-c', 'copy', large]);
    const bytes = (await stat(large)).size;
    assert.ok(bytes > 5 * 1024 ** 3, 'Input size ' + bytes);
    await inputs(large);
    await fill('Начало', '4');
    await fill('Конец', '');
    const started = performance.now();
    await go('Video copy trim >5 GiB without an output buffer', 240_000);
    const output = await page.evaluate(async () => {
      const dir = await navigator.storage.getDirectory();
      const file = await (await dir.getFileHandle('direct-write.mp4')).getFile();
      return { bytes: file.size, signature: await file.slice(4, 8).text() };
    });
    assert.equal(output.signature, 'ftyp');
    assert.ok(output.bytes > 4 * 1024 ** 3 && output.bytes <= bytes * 1.02, 'Output size ' + output.bytes);
    console.log('Large media: ' + bytes + ' -> ' + output.bytes + ' bytes in ' + ((performance.now() - started) / 1000).toFixed(1) + ' s.');

    await fill('Начало', '5');
    await page.getByRole('button', { name: 'Запустить обработку' }).click();
    await page.getByText('Копируем дорожки…').waitFor();
    await page.getByRole('button', { name: 'Отменить обработку' }).click();
    await page.getByText('Обработка отменена.').waitFor();
    const preserved = await page.evaluate(async () => {
      const dir = await navigator.storage.getDirectory();
      return (await (await dir.getFileHandle('direct-write.mp4')).getFile()).size;
    });
    assert.equal(preserved, output.bytes);
    console.log('Cancellation preserved the previously saved result.');
  }

  const lines = network.filter(({ url }) => /^(https?|wss?):/.test(url));
  for (const { method, url, payload } of lines) {
    const target = new URL(url);
    assert.equal(target.origin, origin);
    assert.ok(method === 'GET' || method === 'HEAD', method + ' ' + url);
    assert.ok(!target.search && !payload, url);
    assert.match(target.pathname, /^\/($|favicon\.svg$|assets\/|runtime\/)/);
  }
  assert.ok(lines.some(({ url }) => url.includes('/runtime/ocr/lang/rus.traineddata.gz')));
  assert.ok(lines.some(({ url }) => url.includes('/runtime/pdfjs/worker.mjs')));
  console.log('Passed: 16 tools, disk writer, API method guard and ' + lines.length + ' asset-only requests.');
} catch (error) {
  for (const diagnostic of diagnostics) console.error(diagnostic);
  throw error;
} finally {
  await context?.close();
  await browser?.close();
  if (dirname(resolve(scratch)) === resolve(tmpdir()) && basename(scratch).startsWith('pdfwork-smoke-')) {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}





