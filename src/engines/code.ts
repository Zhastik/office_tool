import QRCode from 'qrcode';
import {
  BarcodeFormat, BinaryBitmap, DecodeHintType, HybridBinarizer, MultiFormatReader, RGBLuminanceSource,
} from '@zxing/library';
import { type Job, type Result, outputFileName } from '../domain';
import { QR_TEXT_LIMIT } from '../extra-tools';
import { inspectImage } from './image';

export async function processCode({ operation, options, files: [file] }: Job): Promise<Result> {
  if (operation === 'qr-generate') {
    const value = await file.text();
    if (!value.trim() || new TextEncoder().encode(value).length > QR_TEXT_LIMIT) {
      throw new Error('Введите текст или ссылку длиной до 1 000 байт UTF-8.');
    }
    if (![256, 512, 1024].includes(options.qrSize) || !['L', 'M', 'Q', 'H'].includes(options.qrLevel)) {
      throw new Error('Выберите допустимый размер PNG и уровень коррекции.');
    }
    let code: ReturnType<typeof QRCode.create>;
    try {
      code = QRCode.create(value, { errorCorrectionLevel: options.qrLevel });
    } catch {
      throw new Error('Текст слишком длинный для выбранной коррекции. Сократите его или снизьте уровень.');
    }
    const size = options.qrSize;
    const scale = Math.floor(size / (code.modules.size + 8));
    const origin = Math.floor((size - code.modules.size * scale) / 2);
    const canvas = new OffscreenCanvas(size, size);
    const graphics = canvas.getContext('2d')!;
    graphics.fillStyle = '#fff';
    graphics.fillRect(0, 0, size, size);
    graphics.fillStyle = '#111';
    for (let row = 0; row < code.modules.size; row++) {
      for (let column = 0; column < code.modules.size; column++) {
        if (code.modules.get(row, column)) graphics.fillRect(origin + column * scale, origin + row * scale, scale, scale);
      }
    }
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { artifacts: [{ name: 'qr-code.png', blob }], note: size + ' × ' + size + ' пикселей' };
  }

  await inspectImage(file);
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, 2500 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const graphics = canvas.getContext('2d', { willReadFrequently: true })!;
    graphics.fillStyle = '#fff';
    graphics.fillRect(0, 0, width, height);
    graphics.drawImage(bitmap, 0, 0, width, height);
    const rgba = graphics.getImageData(0, 0, width, height).data;
    const gray = new Uint8ClampedArray(width * height);
    for (let pixel = 0; pixel < gray.length; pixel++) {
      const offset = pixel * 4;
      gray[pixel] = (rgba[offset] + rgba[offset + 1] * 2 + rgba[offset + 2]) / 4;
    }
    const formats = operation === 'qr-scan' ? [BarcodeFormat.QR_CODE] : [
      BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
      BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93, BarcodeFormat.ITF, BarcodeFormat.CODABAR,
    ];
    const hints = new Map<DecodeHintType, unknown>([[DecodeHintType.POSSIBLE_FORMATS, formats]]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    const reader = new MultiFormatReader();
    const source = new RGBLuminanceSource(gray, width, height);
    let result: ReturnType<MultiFormatReader['decode']> | undefined;
    for (const image of [source, source.invert()]) {
      try {
        result = reader.decode(new BinaryBitmap(new HybridBinarizer(image)), hints);
        break;
      } catch {
        // The second attempt handles light codes on a dark background.
      }
    }
    if (!result) throw new Error('Код не прочитан. Выберите резкое изображение, на котором код виден целиком.');
    const content = result.getText();
    return {
      artifacts: [{ name: outputFileName(file, 'code', 'txt'), blob: new Blob([content], { type: 'text/plain;charset=utf-8' }) }],
      note: BarcodeFormat[result.getBarcodeFormat()],
      preview: content,
    };
  } finally {
    bitmap.close();
  }
}


