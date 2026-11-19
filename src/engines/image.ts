import { IMAGE_LIMIT, IMAGE_PIXELS, fileSize, outputFileName, type Job, type JobContext } from '../domain';

const signature = (bytes: Uint8Array, start: number, value: string) =>
  [...value].every((letter, index) => bytes[start + index] === letter.charCodeAt(0));

export function checkPixels(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('Укажите положительные целые размеры.');
  }
  if (width > 16_384 || height > 16_384 || width * height > IMAGE_PIXELS) {
    throw new Error('Предел — 40 мегапикселей и 16 384 пикселя по каждой стороне.');
  }
}

export async function inspectImage(file: File) {
  if (file.size > IMAGE_LIMIT) throw new Error('Предел для изображения — ' + fileSize(IMAGE_LIMIT) + '.');
  const bytes = new Uint8Array(await file.slice(0, 4 * 1024 * 1024).arrayBuffer());
  const view = new DataView(bytes.buffer);
  let width = 0;
  let height = 0;
  if (bytes.length >= 24 && signature(bytes, 0, '\x89PNG\r\n\x1a\n') && signature(bytes, 12, 'IHDR')) {
    width = view.getUint32(16);
    height = view.getUint32(20);
    for (let offset = 8; offset + 8 <= bytes.length; ) {
      if (signature(bytes, offset + 4, 'IDAT')) break;
      if (signature(bytes, offset + 4, 'acTL')) throw new Error('Выберите статичное изображение. Этот PNG содержит анимацию.');
      offset += 12 + view.getUint32(offset);
    }
  } else if (bytes.length >= 30 && signature(bytes, 0, 'RIFF') && signature(bytes, 8, 'WEBP')) {
    if (signature(bytes, 12, 'VP8X')) {
      if (bytes[20] & 2) throw new Error('Выберите статичное изображение. Этот WebP содержит анимацию.');
      width = 1 + bytes[24] + bytes[25] * 256 + bytes[26] * 65536;
      height = 1 + bytes[27] + bytes[28] * 256 + bytes[29] * 65536;
    } else if (signature(bytes, 12, 'VP8L') && bytes[20] === 47) {
      const size = view.getUint32(21, true);
      width = 1 + (size & 0x3fff);
      height = 1 + ((size >>> 14) & 0x3fff);
    } else if (signature(bytes, 12, 'VP8 ') && signature(bytes, 23, '\x9d\x01\x2a')) {
      width = view.getUint16(26, true) & 0x3fff;
      height = view.getUint16(28, true) & 0x3fff;
    }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 2 < bytes.length && bytes[offset++] === 0xff) {
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 7) {
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        break;
      }
      offset += length;
    }
  }

  if (!width || !height) throw new Error('Не удалось прочитать изображение. Поддерживаются статичные JPEG, PNG и WebP.');
  checkPixels(width, height);
  return { width, height };
}

export async function processImage({ operation, files: [file], options }: Job, context: JobContext) {
  context.progress('Читаем изображение…', 0.1);
  await inspectImage(file);
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    context.signal.throwIfAborted();
    let { width, height } = bitmap;
    if (operation === 'image-ocr') {
      const scale = Math.min(1, 3000 / Math.max(width, height));
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
    } else if (operation === 'image-resize') {
      const requestedWidth = options.width.trim();
      const requestedHeight = options.height.trim();
      if (!requestedWidth && !requestedHeight) throw new Error('Укажите хотя бы одну сторону.');
      width = requestedWidth ? Number(requestedWidth) : Math.max(1, Math.round(bitmap.width * Number(requestedHeight) / bitmap.height));
      height = requestedHeight ? Number(requestedHeight) : Math.max(1, Math.round(bitmap.height * Number(requestedWidth) / bitmap.width));
    }

    checkPixels(width, height);
    const canvas = new OffscreenCanvas(width, height);
    try {
      const graphics = canvas.getContext('2d');
      if (!graphics) throw new Error('В этом браузере недоступна обработка изображений в воркере.');
      const mime = operation === 'image-ocr' ? 'image/png' : options.imageFormat;
      if (mime === 'image/jpeg' || operation === 'image-ocr') {
        graphics.fillStyle = '#fff';
        graphics.fillRect(0, 0, width, height);
      }
      graphics.imageSmoothingQuality = 'high';
      graphics.drawImage(bitmap, 0, 0, width, height);
      if (operation === 'image-ocr') {
        const { recognizePages } = await import('./ocr');
        const text = await recognizePages(options.language, 1, () => canvas.convertToBlob(), context);
        return {
          artifacts: [{ name: outputFileName(file, 'ocr', 'txt'), blob: new Blob([text], { type: 'text/plain;charset=utf-8' }) }],
          note: text.trim() ? undefined : 'Модель не нашла читаемый текст.',
        };
      }

      context.progress('Кодируем изображение…', 0.7);
      const blob = await canvas.convertToBlob({ type: mime, quality: options.quality / 100 });
      if (blob.type !== mime) throw new Error('В этом браузере недоступна запись в выбранном формате.');
      const suffix = operation === 'image-resize' ? width + 'x' + height : operation === 'image-compress' ? 'compressed' : 'converted';
      const extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
      return { artifacts: [{ name: outputFileName(file, suffix, extension), blob }], note: width + ' × ' + height + ' пикселей' };
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    bitmap.close();
  }
}

