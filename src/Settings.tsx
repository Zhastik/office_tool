import { cloneElement, useId, type ChangeEvent, type ReactElement, type ReactNode } from 'react';
import { ChevronDown, HardDrive } from 'lucide-react';
import {
  MEDIA_LIMIT, fileSize, formatTime,
  type AudioFormat, type FileInfo, type ImageFormat, type Operation, type Options, type VideoFormat,
} from './domain';

interface Props {
  operation: Operation;
  values: Options;
  onChange: (options: Partial<Options>) => void;
  info?: FileInfo;
  canWrite: boolean;
  writeToDisk: boolean;
  onWriteToDisk: (value: boolean) => void;
}

function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return <div className="field">
    <label className="field-label" htmlFor={id}>{label}</label>
    {cloneElement(children, { id })}
  </div>;
}

function Select({ children, ...props }: {
  id?: string;
  value: string | number;
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  children: ReactNode;
}) {
  return <span className="select-wrap"><select {...props}>{children}</select><ChevronDown aria-hidden="true" size={15} /></span>;
}

const pageFields = {
  'pdf-split': { label: 'Диапазоны для частей' },
  'pdf-extract': { label: 'Номера страниц' },
  'pdf-delete': { label: 'Страницы для удаления' },
  'pdf-reorder': { label: 'Новый порядок' },
  'pdf-rotate': { label: 'Страницы для поворота' },
  'pdf-text': { label: 'Страницы для извлечения' },
  'pdf-ocr': { label: 'Страницы для распознавания' },
  'pdf-jpg': { label: 'Страницы для JPG' },
  'pdf-docx': { label: 'Страницы для Word' },
  'pdf-html': { label: 'Страницы для HTML' },
  'pdf-xlsx': { label: 'Страницы для Excel' },
  'pdf-csv': { label: 'Страницы для CSV' },
  'statement-export': { label: 'Страницы PDF' },
};

export function Settings({ operation, values, onChange, info, canWrite, writeToDisk, onWriteToDisk }: Props) {
  const pageField = pageFields[operation as keyof typeof pageFields];
  const ocr = operation.endsWith('ocr') || operation === 'image-docx' || operation === 'image-xlsx';
  const image = (['image-convert', 'image-resize', 'image-compress', 'image-invert'] as Operation[]).includes(operation);
  const media = operation.startsWith('video-') || operation.startsWith('audio-');
  const trim = operation.endsWith('trim');
  const compressImage = operation === 'image-compress';

  return <>
    {pageField && <Field label={pageField.label}>
      <input value={values.pages} onChange={(event) => onChange({ pages: event.target.value })}
        placeholder={operation === 'pdf-split' ? '1–3; 4–7; 8–10' : operation === 'pdf-reorder' ? '3, 1, 2' : '1, 3–5, 8'} />
    </Field>}

    {operation === 'pdf-rotate' && <Field label="Угол поворота">
      <Select value={values.rotation} onChange={(event) => onChange({ rotation: Number(event.target.value) })}>
        <option value={90}>90° вправо</option><option value={180}>180°</option><option value={270}>90° влево</option>
      </Select>
    </Field>}

    {ocr && <Field label="Язык документа">
      <Select value={values.language} onChange={(event) => onChange({ language: event.target.value as Options['language'] })}>
        <option value="rus+eng">Русский и английский</option><option value="rus">Русский</option><option value="eng">Английский</option>
      </Select>
    </Field>}

    {operation === 'image-resize' && <div className="field-row">
      <Field label="Ширина, px"><input type="number" min="1" max="16384" value={values.width} placeholder={String(info?.width ?? 'Авто')} onChange={(event) => onChange({ width: event.target.value })} /></Field>
      <Field label="Высота, px"><input type="number" min="1" max="16384" value={values.height} placeholder={String(info?.height ?? 'Авто')} onChange={(event) => onChange({ height: event.target.value })} /></Field>
    </div>}

    {image && <Field label="Формат результата">
      <Select value={values.imageFormat} onChange={(event) => onChange({ imageFormat: event.target.value as ImageFormat })}>
        <option value="image/webp">WebP (.webp)</option><option value="image/jpeg">JPEG (.jpg)</option>
        {!compressImage && <option value="image/png">PNG (.png)</option>}
      </Select>
    </Field>}

    {((image && values.imageFormat !== 'image/png') || operation === 'pdf-jpg') && <Field label={'Качество · ' + values.quality + '%'}>
      <input type="range" min="10" max="100" value={values.quality} onChange={(event) => onChange({ quality: Number(event.target.value) })} />
    </Field>}

    {trim && <>
      <div className="field-row">
        <Field label="Начало"><input value={values.start} placeholder="0:00" onChange={(event) => onChange({ start: event.target.value })} /></Field>
        <Field label="Конец"><input value={values.end} placeholder={info?.duration ? formatTime(info.duration) : 'До конца'} onChange={(event) => onChange({ end: event.target.value })} /></Field>
      </div>

    </>}

    {operation === 'video-compress' && <Field label="Формат результата">
      <Select value={values.videoFormat} onChange={(event) => onChange({ videoFormat: event.target.value as VideoFormat })}>
        <option value="mp4">MP4 · H.264</option><option value="webm">WebM · VP8</option>
      </Select>
    </Field>}

    {operation === 'video-compress' && <div className="field-row">
      <Field label="Высота видео">
        <Select value={values.videoHeight} onChange={(event) => onChange({ videoHeight: Number(event.target.value) })}>
          <option value={480}>480p</option><option value={720}>720p</option><option value={1080}>1080p</option>
        </Select>
      </Field>
      <Field label="Битрейт, Мбит/с">
        <input type="number" min="0.2" max="20" step="0.1" required value={Number.isNaN(values.bitrate) ? '' : values.bitrate} onChange={(event) => onChange({ bitrate: event.target.valueAsNumber })} />
      </Field>
    </div>}

    {operation.startsWith('audio-') && <Field label="Формат результата">
      <Select value={values.audioFormat} onChange={(event) => onChange({ audioFormat: event.target.value as AudioFormat })}>
        <option value="wav">WAV (.wav)</option><option value="opus">Ogg Opus (.ogg)</option>
      </Select>
    </Field>}

    {(['text-pdf', 'text-docx', 'text-image', 'html-pdf', 'docx-pdf', 'docx-jpg', 'image-docx', 'image-pdf',
      'pdf-docx', 'xlsx-pdf', 'xlsx-jpg'] as Operation[]).includes(operation) && <Field label="Формат страницы">
      <Select value={values.paper} onChange={(event) => onChange({ paper: event.target.value as Options['paper'] })}>
        <option value="a4">A4</option><option value="letter">Letter</option>
        {operation === 'image-pdf' && <option value="fit">Под размер изображения</option>}
      </Select>
    </Field>}

    {(['text-pdf', 'text-image', 'html-pdf', 'docx-pdf', 'docx-jpg', 'pptx-pdf'] as Operation[]).includes(operation) &&
      <Field label="Размер текста, пт">
        <input type="number" min="9" max="28" required value={Number.isNaN(values.fontSize) ? '' : values.fontSize}
          onChange={(event) => onChange({ fontSize: event.target.valueAsNumber })} />
      </Field>}

    {operation === 'pdf-jpg' && <Field label="Разрешение JPG, dpi">
      <input type="number" min="72" max="220" required value={Number.isNaN(values.dpi) ? '' : values.dpi}
        onChange={(event) => onChange({ dpi: event.target.valueAsNumber })} />
    </Field>}

    {operation.startsWith('xlsx-') && <div className="field-row">
      <Field label="Номер листа"><input type="number" min="1" max="3000" required
        value={Number.isNaN(values.sheet) ? '' : values.sheet} onChange={(event) => onChange({ sheet: event.target.valueAsNumber })} /></Field>
      <Field label="Диапазон ячеек"><input value={values.tableRange} placeholder="A1:D20"
        onChange={(event) => onChange({ tableRange: event.target.value })} /></Field>
    </div>}

    {(['csv-xlsx', 'xlsx-csv', 'pdf-csv', 'statement-export'] as Operation[]).includes(operation) &&
      <Field label="Разделитель CSV">
        <Select value={values.delimiter} onChange={(event) => onChange({ delimiter: event.target.value as Options['delimiter'] })}>
          <option value=";">Точка с запятой (;)</option><option value=",">Запятая (,)</option><option value={'\t'}>Табуляция</option>
        </Select>
      </Field>}

    {operation === 'statement-export' && <Field label="Формат выписки">
      <Select value={values.statementFormat} onChange={(event) => onChange({ statementFormat: event.target.value as Options['statementFormat'] })}>
        <option value="xlsx">Excel (.xlsx)</option><option value="csv">CSV (.csv)</option>
      </Select>
    </Field>}

    {operation === 'qr-generate' && <div className="field-row">
      <Field label="Размер QR-кода">
        <Select value={values.qrSize} onChange={(event) => onChange({ qrSize: Number(event.target.value) })}>
          <option value={256}>256 × 256</option><option value={512}>512 × 512</option><option value={1024}>1024 × 1024</option>
        </Select>
      </Field>
      <Field label="Коррекция ошибок">
        <Select value={values.qrLevel} onChange={(event) => onChange({ qrLevel: event.target.value as Options['qrLevel'] })}>
          <option value="L">Низкая (L)</option><option value="M">Средняя (M)</option><option value="Q">Высокая (Q)</option><option value="H">Максимальная (H)</option>
        </Select>
      </Field>
    </div>}

    {operation === 'photo-translate' && <Field label="Направление перевода">
      <Select value={values.translationDirection} onChange={(event) => onChange({ translationDirection: event.target.value as Options['translationDirection'] })}>
        <option value="en-ru">С английского на русский</option><option value="ru-en">С русского на английский</option>
      </Select>
    </Field>}

    {media && (canWrite ? <label className="disk-choice">
      <input type="checkbox" checked={writeToDisk} onChange={(event) => onWriteToDisk(event.target.checked)} />
      <HardDrive size={17} aria-hidden="true" />
      <span>Сохранять сразу на диск</span>
    </label> : <p className="field-note disk-note">Для результатов больше {fileSize(MEDIA_LIMIT)} нужен браузер с прямой записью на диск, например настольный Chrome или Edge.</p>)}
  </>;
}





