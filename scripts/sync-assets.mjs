import { copyFile, cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const modules = join(root, 'node_modules');
const runtime = join(root, 'public', 'runtime');
const pdfjs = join(modules, 'pdfjs-dist');
const tesseractCore = join(modules, 'tesseract.js-core');
const ocr = join(runtime, 'ocr');

await Promise.all([
  mkdir(join(runtime, 'pdfjs'), { recursive: true }),
  mkdir(join(runtime, 'fonts'), { recursive: true }),
  mkdir(join(ocr, 'core'), { recursive: true }),
  mkdir(join(ocr, 'lang'), { recursive: true }),
]);

const coreFiles = [
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-relaxedsimd-lstm.wasm.js',
];

await Promise.all([
  copyFile(join(root, 'src', 'fonts', 'OFL-NotoSans.txt'), join(runtime, 'fonts', 'OFL-NotoSans.txt')),
  copyFile(join(pdfjs, 'build', 'pdf.worker.min.mjs'), join(runtime, 'pdfjs', 'worker.mjs')),
  ...['cmaps', 'standard_fonts', 'wasm', 'iccs'].map((directory) =>
    cp(join(pdfjs, directory), join(runtime, 'pdfjs', directory), { recursive: true }),
  ),
  copyFile(join(modules, 'tesseract.js', 'dist', 'worker.min.js'), join(ocr, 'worker.js')),
  ...coreFiles.map((file) => copyFile(join(tesseractCore, file), join(ocr, 'core', file))),
  ...['eng', 'rus'].map((lang) => copyFile(
    join(modules, '@tesseract.js-data', lang, '4.0.0_best_int', lang + '.traineddata.gz'),
    join(ocr, 'lang', lang + '.traineddata.gz'),
  )),
]);

