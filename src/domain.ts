import { DOCUMENT_LIMIT_MIB, extraTools, TEXT_LIMIT } from './extra-tools';

export const MIB = 1024 * 1024;
export const PDF_LIMIT = 150 * MIB;
export const IMAGE_LIMIT = 128 * MIB;
export const IMAGE_PIXELS = 40_000_000;
export const MEDIA_LIMIT = 128 * MIB;

export const categories = [
  { id: 'pdf', label: 'PDF' },
  { id: 'image', label: 'Изображения' },
  { id: 'video', label: 'Видео' },
  { id: 'audio', label: 'Аудио' },
  { id: 'document', label: 'Документы' },
  { id: 'table', label: 'Таблицы' },
  { id: 'code', label: 'QR и штрихкоды' },
] as const;

export type Category = (typeof categories)[number]['id'];

const originalOperations = [
  { id: 'pdf-merge', category: 'pdf', label: 'Объединить', title: 'Объединить PDF', description: 'Соберите страницы нескольких файлов в один PDF. Порядок файлов можно изменить.' },
  { id: 'pdf-split', category: 'pdf', label: 'Разделить', title: 'Разделить PDF', description: 'Сохраните каждый указанный диапазон страниц отдельным PDF.' },
  { id: 'pdf-extract', category: 'pdf', label: 'Извлечь страницы', title: 'Извлечь страницы', description: 'Скопируйте указанные страницы в новый PDF.' },
  { id: 'pdf-delete', category: 'pdf', label: 'Удалить страницы', title: 'Удалить страницы', description: 'Сохраните PDF без указанных страниц.' },
  { id: 'pdf-reorder', category: 'pdf', label: 'Изменить порядок', title: 'Изменить порядок', description: 'Укажите новый порядок всех страниц исходного документа.' },
  { id: 'pdf-rotate', category: 'pdf', label: 'Повернуть', title: 'Повернуть страницы', description: 'Поверните выбранные страницы по часовой стрелке.' },
  { id: 'pdf-text', category: 'pdf', label: 'Извлечь текст', title: 'Извлечь текст из PDF', description: 'Сохраните текстовый слой выбранных страниц в TXT.' },
  { id: 'pdf-ocr', category: 'pdf', label: 'Распознать скан', title: 'Распознать текст на скане', description: 'Распознайте текст на выбранных страницах. Результат сохранится в TXT.' },
  { id: 'image-convert', category: 'image', label: 'Конвертировать', title: 'Конвертировать изображение', description: 'Сохраните изображение в JPEG, PNG или WebP.' },
  { id: 'image-resize', category: 'image', label: 'Размер', title: 'Изменить размер', description: 'Укажите ширину, высоту или обе стороны в пикселях.' },
  { id: 'image-compress', category: 'image', label: 'Сжать', title: 'Сжать изображение', description: 'Настройте качество JPEG или WebP и сравните размер результата с исходником.' },
  { id: 'image-ocr', category: 'image', label: 'Распознать текст', title: 'Распознать текст на изображении', description: 'Распознайте текст на фото или скане и сохраните его в TXT.' },
  { id: 'video-trim', category: 'video', label: 'Обрезать', title: 'Обрезать без перекодирования', description: 'Сохраните фрагмент в MP4. Начало и конец подстраиваются под границы кадров и аудиопакетов внутри выбранного интервала.' },
  { id: 'video-compress', category: 'video', label: 'Сжать', title: 'Сжать видео', description: 'Настройте разрешение и битрейт. Выберите MP4 (H.264) или WebM (VP8) в зависимости от поддержки кодеков браузером.' },
  { id: 'audio-convert', category: 'audio', label: 'Конвертировать', title: 'Конвертировать аудио', description: 'Сохраните звуковой файл в WAV или Ogg Opus.' },
  { id: 'audio-trim', category: 'audio', label: 'Обрезать', title: 'Обрезать аудио', description: 'Укажите интервал и сохраните фрагмент в WAV или Ogg Opus.' },
] as const;

export type InspectCategory = 'pdf' | 'image' | 'video' | 'audio';
export type Source = InspectCategory | 'docx' | 'xlsx' | 'csv' | 'pptx' | 'statement' | 'text' | 'html';
export type Operation = (typeof originalOperations)[number]['id'] | (typeof extraTools)[number]['id'];

export interface OperationInfo {
  id: Operation;
  category: Category;
  source: Source;
  label: string;
  title: string;
  description: string;
  files?: number;
}

export const operations: OperationInfo[] = [
  ...originalOperations.map((item) => ({ ...item, source: item.category, files: item.id === 'pdf-merge' ? 50 : 1 })),
  ...extraTools.map((item) => ({ ...item, title: item.label })),
];

export const sourceRules: Record<Source, { formats: string; accept: string; limit?: number; inline?: boolean; inspect?: InspectCategory }> = {
  pdf: { formats: 'PDF', accept: '.pdf,application/pdf', limit: PDF_LIMIT, inspect: 'pdf' },
  image: { formats: 'JPEG, PNG, WebP', accept: '.jpg,.jpeg,.png,.webp', limit: IMAGE_LIMIT, inspect: 'image' },
  video: { formats: 'MP4, MOV, WebM, MKV', accept: '.mp4,.m4v,.mov,.webm,.mkv', inspect: 'video' },
  audio: { formats: 'MP3, WAV, M4A, OGG, FLAC', accept: '.mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.flac,.webm', inspect: 'audio' },
  docx: { formats: 'DOCX', accept: '.docx', limit: DOCUMENT_LIMIT_MIB * MIB },
  xlsx: { formats: 'XLSX', accept: '.xlsx', limit: DOCUMENT_LIMIT_MIB * MIB },
  pptx: { formats: 'PPTX', accept: '.pptx', limit: DOCUMENT_LIMIT_MIB * MIB },
  csv: { formats: 'CSV · UTF-8', accept: '.csv', limit: DOCUMENT_LIMIT_MIB * MIB },
  statement: { formats: 'PDF или CSV', accept: '.pdf,.csv', limit: DOCUMENT_LIMIT_MIB * MIB },
  text: { formats: 'TXT · UTF-8', accept: '.txt,text/plain', inline: true, limit: TEXT_LIMIT },
  html: { formats: 'HTML · UTF-8', accept: '.html,.htm,text/html', inline: true, limit: TEXT_LIMIT },
};
export type ImageFormat = 'image/jpeg' | 'image/png' | 'image/webp';
export type AudioFormat = 'wav' | 'opus';
export type VideoFormat = 'mp4' | 'webm';

export interface Options {
  pages: string;
  rotation: number;
  language: 'rus+eng' | 'rus' | 'eng';
  imageFormat: ImageFormat;
  quality: number;
  width: string;
  height: string;
  start: string;
  end: string;
  videoFormat: VideoFormat;
  videoHeight: number;
  bitrate: number;
  audioFormat: AudioFormat;
  dpi: number;
  paper: 'a4' | 'letter' | 'fit';
  fontSize: number;
  sheet: number;
  delimiter: ';' | ',' | '\t';
  tableRange: string;
  statementFormat: 'xlsx' | 'csv';
  qrSize: number;
  qrLevel: 'L' | 'M' | 'Q' | 'H';
  translationDirection: 'en-ru' | 'ru-en';
}

export const defaultOptions: Options = {
  pages: '',
  rotation: 90,
  language: 'rus+eng',
  imageFormat: 'image/webp',
  quality: 80,
  width: '',
  height: '',
  start: '0',
  end: '',
  videoFormat: 'mp4',
  videoHeight: 720,
  bitrate: 2.5,
  audioFormat: 'wav',
  dpi: 144,
  paper: 'a4',
  fontSize: 13,
  sheet: 1,
  delimiter: ';',
  tableRange: '',
  statementFormat: 'xlsx',
  qrSize: 512,
  qrLevel: 'M',
  translationDirection: 'en-ru',
};

export type Destination = FileSystemFileHandle;

export interface PickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<Destination>;
}

export interface Job {
  operation: Operation;
  files: File[];
  options: Options;
  destination?: Destination;
}

export interface Artifact {
  name: string;
  blob: Blob;
}

export interface Result {
  artifacts: Artifact[];
  saved?: { name: string; bytes: number };
  note?: string;
  preview?: string;
}

export interface FileInfo {
  pages?: number;
  width?: number;
  height?: number;
  duration?: number;
  codecs?: string[];
}

export type WorkerRequest =
  | { type: 'inspect'; category: InspectCategory; file: File }
  | { type: 'run'; job: Job }
  | { type: 'cancel' };

export type WorkerResponse =
  | { type: 'info'; info: FileInfo }
  | { type: 'progress'; label: string; fraction?: number }
  | { type: 'result'; result: Result }
  | { type: 'error'; message: string }
  | { type: 'cancelled' };

export interface JobContext {
  signal: AbortSignal;
  progress: (label: string, fraction?: number) => void;
}

export function outputFileName(file: File, suffix: string, extension: string) {
  const stem = file.name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  return (stem.slice(0, 110) || 'file') + '-' + suffix + '.' + extension;
}

export function fileSize(bytes: number) {
  if (bytes >= 1024 * MIB) return (bytes / (1024 * MIB)).toLocaleString('ru', { maximumFractionDigits: 1 }) + ' ГБ';
  if (bytes >= MIB) return (bytes / MIB).toLocaleString('ru', { maximumFractionDigits: 1 }) + ' МБ';
  if (bytes >= 1024) return (bytes / 1024).toLocaleString('ru', { maximumFractionDigits: 1 }) + ' КБ';
  return bytes + ' Б';
}

export function parseTime(value: string) {
  const parts = value.trim().replace(',', '.').split(':');
  if (parts.length > 3 || !parts.every((part, index) =>
    (index === parts.length - 1 ? /^\d+(\.\d+)?$/ : /^\d+$/).test(part)
    && (index === 0 || Number(part) < 60),
  )) {
    throw new Error('Укажите время в секундах, ММ:СС или ЧЧ:ММ:СС.');
  }
  const time = parts.reduce((total, part) => total * 60 + Number(part), 0);
  if (!Number.isFinite(time)) throw new Error('Время выходит за допустимый диапазон.');
  return time;
}

export function formatTime(seconds: number) {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return (hours ? hours + ':' + String(minutes).padStart(2, '0') : String(minutes)) + ':' + rest;
}

export function mediaOutput(job: Pick<Job, 'operation' | 'files' | 'options'>) {
  const operation = job.operation;
  const suffix = operation.endsWith('trim') ? 'clip' : operation.endsWith('compress') ? 'compressed' : 'converted';
  const extension = operation === 'video-trim' ? 'mp4' : operation === 'video-compress' ? job.options.videoFormat : job.options.audioFormat === 'opus' ? 'ogg' : 'wav';
  const mime = extension === 'mp4' ? 'video/mp4' : extension === 'webm' ? 'video/webm' : extension === 'ogg' ? 'audio/ogg' : 'audio/wav';
  return { name: outputFileName(job.files[0], suffix, extension), extension, mime };
}



