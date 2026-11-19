import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import {
  AudioLines, Check, CircleAlert, ChevronDown, ChevronUp, Download, File as FileIcon, FileImage, FileStack,
  FileText, Film, FolderOpen, Image, ListOrdered, LockKeyhole, Maximize, Play, RotateCw, ScanText,
  Scissors, ShieldCheck, SlidersHorizontal, Split, Trash2, Upload, X, QrCode, Barcode, Table2, Search, LayoutGrid, Languages, type LucideIcon,
} from 'lucide-react';
import { Settings } from './Settings';
import { SettingsGuide } from './SettingsGuide';
import { QR_TEXT_LIMIT } from './extra-tools';
import { canTranslateOnDevice, prepareTranslator } from './translator';
import {
  categories, defaultOptions, operations, sourceRules, MEDIA_LIMIT, fileSize, formatTime, mediaOutput, outputFileName,
  type Artifact, type Category, type FileInfo, type Job, type Operation, type Options,
  type OperationInfo, type PickerWindow, type Result, type WorkerRequest, type WorkerResponse,
} from './domain';

const categoryIcons: Record<Category, LucideIcon> = {
  pdf: FileText, image: Image, video: Film, audio: AudioLines, document: FileStack, table: Table2, code: QrCode,
};
const operationIcons: Partial<Record<Operation, LucideIcon>> = {
  'pdf-merge': FileStack, 'pdf-split': Split, 'pdf-extract': FileText, 'pdf-delete': Trash2,
  'pdf-reorder': ListOrdered, 'pdf-rotate': RotateCw, 'pdf-text': FileText, 'pdf-ocr': ScanText,
  'image-convert': FileImage, 'image-resize': Maximize, 'image-compress': SlidersHorizontal, 'image-ocr': ScanText,
  'photo-translate': Languages, 'qr-generate': QrCode, 'qr-scan': QrCode, 'barcode-scan': Barcode,
  'video-trim': Scissors, 'video-compress': SlidersHorizontal, 'audio-convert': AudioLines, 'audio-trim': Scissors,
};

type DownloadItem = Artifact & { url: string };
type TranslationAttempt = { controller: AbortController; device?: Awaited<ReturnType<typeof prepareTranslator>> };
type Task =
  | { state: 'idle' | 'choosing' | 'cancelling' | 'cancelled' }
  | { state: 'running'; label: string; fraction?: number }
  | { state: 'error'; message: string }
  | { state: 'done'; result: Result; downloads: DownloadItem[] };

interface ActiveJob {
  worker: Worker;
  writingToDisk: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

function newWorker() {
  return new Worker(new URL('./processor.worker.ts', import.meta.url), { type: 'module' });
}

function Preview({ file, video, onTime }: { file: File; video: boolean; onTime: (patch: Partial<Options>) => void }) {
  const [url, setUrl] = useState('');
  const player = useRef<HTMLMediaElement | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);

  const setBoundary = (key: 'start' | 'end') => {
    if (player.current && Number.isFinite(player.current.duration)) {
      onTime({ [key]: String(Math.round(player.current.currentTime * 1000) / 1000) });
    }
  };

  return <div className="media-preview">
    {video
      ? <video ref={(node) => { player.current = node; }} controls preload="metadata" src={url || undefined} />
      : <audio ref={(node) => { player.current = node; }} controls preload="metadata" src={url || undefined} />}
    <div className="preview-actions">
      <button type="button" className="text-button" onClick={() => setBoundary('start')}>Начало здесь</button>
      <button type="button" className="text-button" onClick={() => setBoundary('end')}>Конец здесь</button>
    </div>
  </div>;
}

function TaskStatus({ task, inputSize, showImage }: { task: Task; inputSize: number; showImage: boolean }) {
  if (task.state === 'idle' || task.state === 'choosing') return null;
  if (task.state === 'running' || task.state === 'cancelling') {
    const fraction = task.state === 'running' ? task.fraction : undefined;
    return <section className="task-status working" aria-live="polite">
      <div className="task-heading">
        <span>{task.state === 'running' ? task.label : 'Отменяем обработку…'}</span>
        {fraction !== undefined && <span>{Math.min(99, Math.floor(fraction * 100))}%</span>}
      </div>
      <progress aria-label="Обработка файла" value={fraction === undefined ? undefined : Math.min(0.99, fraction)} max={1} />
    </section>;
  }

  if (task.state === 'error') return <div className="task-status error" role="alert">
    <CircleAlert size={18} /><p>{task.message}</p>
  </div>;
  if (task.state === 'cancelled') return <div className="task-status quiet" role="status">Обработка отменена.</div>;
  if (task.state !== 'done') return null;

  const { result, downloads } = task;
  const actual = result.saved?.bytes ?? (downloads.length === 1 ? downloads[0].blob.size : undefined);
  return <section className="task-status done" aria-label="Результат">
    <div className="task-heading"><span><Check size={17} /> {result.saved ? 'Файл сохранён' : 'Готово'}</span></div>
    {result.saved && <p className="saved-name">{result.saved.name} · {fileSize(result.saved.bytes)}</p>}
    {result.note && <p>{result.note}</p>}
    {result.preview && <pre className="result-preview" tabIndex={0}>{result.preview}</pre>}
    {showImage && downloads[0] && <img className="qr-preview" src={downloads[0].url} alt="Созданный QR-код" />}
    {actual !== undefined && <p className="result-size">Исходник {fileSize(inputSize)} · Результат {fileSize(actual)}</p>}
    {downloads.map(({ name, blob, url }) => <a className="download-row" key={name} href={url} download={name}>
      <span>{name}<small>{fileSize(blob.size)}</small></span><Download size={17} aria-label="Скачать" />
    </a>)}
  </section>;
}

export function App() {
  const [categoryId, setCategoryId] = useState<Category>('pdf');
  const [operationId, setOperationId] = useState<Operation>('pdf-merge');
  const [values, setValues] = useState<Options>(defaultOptions);
  const [files, setFiles] = useState<File[]>([]);
  const [draft, setDraft] = useState('');
  const [draftFileName, setDraftFileName] = useState('');
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [info, setInfo] = useState<FileInfo>();
  const [fileError, setFileError] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [task, setTask] = useState<Task>({ state: 'idle' });
  const [dragging, setDragging] = useState(false);
  const [diskChoice, setDiskChoice] = useState<boolean>();
  const [preview, setPreview] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const active = useRef<ActiveJob | null>(null);
  const startLock = useRef(false);
  const translation = useRef<TranslationAttempt | null>(null);
  const importVersion = useRef(0);
  const dragDepth = useRef(0);
  const operation = operations.find((item) => item.id === operationId)!;
  const source = sourceRules[operation.source];
  const inline = !!source.inline;
  const maxFiles = operation.files ?? 1;
  const multiple = maxFiles > 1;
  const minFiles = operationId === 'pdf-merge' ? 2 : 1;
  const searchTerms = search.toLocaleLowerCase('ru').trim().split(/\s+/).filter(Boolean);
  const catalogOpen = showAll || searchTerms.length > 0;
  const categoryOperations = operations.filter((item) => {
    if (!catalogOpen) return item.category === categoryId;
    const text = [item.label, item.title, item.id, sourceRules[item.source].formats].join(' ').toLocaleLowerCase('ru');
    return searchTerms.every((term) => text.includes(term));
  });
  const SourceIcon = categoryIcons[source.inspect ?? categoryId];
  const media = source.inspect === 'video' || source.inspect === 'audio';
  const busy = ['running', 'choosing', 'cancelling'].includes(task.state);
  const canWrite = typeof (window as PickerWindow).showSaveFilePicker === 'function';
  const primaryFile = files[0];
  const inputSize = inline ? new Blob([draft]).size : files.reduce((sum, file) => sum + file.size, 0);
  const writeToDisk = diskChoice ?? (canWrite && inputSize > MEDIA_LIMIT);
  const inputLimit = operationId === 'qr-generate' ? QR_TEXT_LIMIT : source.limit;
  const limitError = inputLimit && inputSize > inputLimit ? 'Исходные данные превышают предел ' + fileSize(inputLimit) + '.' : '';
  const downloads = task.state === 'done' ? task.downloads : undefined;

  useEffect(() => () => {
    downloads?.forEach(({ url }) => URL.revokeObjectURL(url));
  }, [downloads]);

  useEffect(() => () => {
    translation.current?.controller.abort();
    translation.current?.device?.destroy();
    if (!active.current) return;
    clearTimeout(active.current.timer);
    active.current.worker.terminate();
  }, []);

  useEffect(() => {
    setInfo(undefined);
    setFileError('');
    setPreview(false);
    if (!primaryFile || multiple || !source.inspect) {
      setInspecting(false);
      return;
    }
    setInspecting(true);
    const worker = newWorker();
    const message: WorkerRequest = { type: 'inspect', category: source.inspect, file: primaryFile };
    worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      if (data.type === 'info') setInfo(data.info);
      if (data.type === 'error') setFileError(data.message);
      setInspecting(false);
      worker.terminate();
    };
    worker.onerror = () => {
      setFileError('Не удалось запустить обработчик. Перезагрузите страницу.');
      setInspecting(false);
      worker.terminate();
    };
    worker.postMessage(message);
    return () => worker.terminate();
  }, [primaryFile, source.inspect, multiple]);

  function chooseTool(next: OperationInfo, resetInput = false) {
    if (busy) return;
    setSearch('');
    setShowAll(false);
    if (next.id === operationId) return;
    importVersion.current++;
    setCategoryId(next.category);
    setOperationId(next.id);
    setFiles((previous) => resetInput || next.source !== operation.source ? [] : previous.slice(0, next.files ?? 1));
    if (resetInput || next.source !== operation.source) {
      setDraft('');
      setDraftFileName('');
      setDiskChoice(undefined);
    }
    setValues({ ...defaultOptions, pages: next.id === 'pdf-ocr' ? '1' : '' });
    setTask({ state: 'idle' });
  }

  function chooseCategory(id: Category) {
    if (id === categoryId) {
      setSearch('');
      setShowAll(false);
    } else {
      chooseTool(operations.find((item) => item.category === id)!, true);
    }
  }

  function updateDraft(value: string) {
    importVersion.current++;
    setDraft(value);
    setTask({ state: 'idle' });
  }

  async function importDraft(file: File) {
    const version = ++importVersion.current;
    if (inputLimit && file.size > inputLimit) {
      setTask({ state: 'error', message: 'Текстовый файл должен занимать до ' + fileSize(inputLimit) + '.' });
      return;
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (importVersion.current !== version) return;
      setDraft(text);
      setDraftFileName(file.name);
      setTask({ state: 'idle' });
    } catch {
      if (importVersion.current === version) setTask({ state: 'error', message: 'Сохраните текстовый файл в кодировке UTF-8.' });
    }
  }

  function updateValues(patch: Partial<Options>) {
    if (busy) return;
    setValues((previous) => ({ ...previous, ...patch }));
    setTask({ state: 'idle' });
  }

  function addFiles(list: FileList | File[]) {
    if (busy || !list.length) return;
    const next = Array.from(list);
    if (!multiple && next.length > 1) {
      setTask({ state: 'error', message: 'Для этого действия выберите один файл.' });
      return;
    }
    if (multiple && files.length + next.length > maxFiles) {
      setTask({ state: 'error', message: 'Предел файлов для этого действия — ' + maxFiles + '.' });
      return;
    }
    setFiles((previous) => multiple ? [...previous, ...next] : next);
    setTask({ state: 'idle' });
  }

  function moveFile(index: number, offset: number) {
    setFiles((previous) => {
      const next = previous.slice();
      [next[index], next[index + offset]] = [next[index + offset], next[index]];
      return next;
    });
    setTask({ state: 'idle' });
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!busy) addFiles(event.dataTransfer.files);
  }

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (startLock.current || !ready) return;
    startLock.current = true;
    const input = inline
      ? [new File([draft], draftFileName || (operation.source === 'html' ? 'document.html' : 'text.txt'))]
      : files;
    const job: Job = { operation: operationId, files: input, options: values };
    const attempt: TranslationAttempt | undefined = operationId === 'photo-translate'
      ? { controller: new AbortController() } : undefined;
    if (attempt) translation.current = attempt;
    const releaseTranslation = () => {
      if (attempt && translation.current === attempt) {
        attempt.device?.destroy();
        translation.current = null;
      }
    };
    try {
      if (attempt) {
        setTask({ state: 'running', label: 'Проверяем локальный переводчик…' });
        const device = await prepareTranslator(values.translationDirection, attempt.controller.signal, (label, fraction) => {
          if (translation.current === attempt) setTask({ state: 'running', label, fraction });
        });
        if (attempt.controller.signal.aborted) {
          device.destroy();
          return;
        }
        attempt.device = device;
      }
      if (media && canWrite && writeToDisk) {
        const picker = (window as PickerWindow).showSaveFilePicker!;
        const output = mediaOutput(job);
        setTask({ state: 'choosing' });
        job.destination = await picker.call(window, {
          suggestedName: output.name,
          types: [{ description: output.extension.toUpperCase(), accept: { [output.mime]: ['.' + output.extension] } }],
        });
      }
      const worker = newWorker();
      const current: ActiveJob = { worker, writingToDisk: !!job.destination };
      active.current = current;
      const finish = (next: Task) => {
        if (active.current !== current) return;
        releaseTranslation();
        clearTimeout(current.timer);
        worker.terminate();
        active.current = null;
        startLock.current = false;
        setTask(next);
      };
      worker.onerror = () => finish({ state: 'error', message: 'Браузер остановил обработчик. Проверьте доступную память и попробуйте снова.' });
      worker.onmessage = async ({ data }: MessageEvent<WorkerResponse>) => {
        if (data.type === 'progress') {
          setTask((before) => before.state === 'cancelling' ? before : { state: 'running', label: data.label, fraction: data.fraction });
        } else if (data.type === 'result') {
          let result = data.result;
          if (attempt?.device) {
            const signal = attempt.controller.signal;
            setTask({ state: 'running', label: 'Переводим распознанный текст…' });
            try {
              const original = await result.artifacts[0].blob.text();
              signal.throwIfAborted();
              const translated = await attempt.device.translate(original, { signal });
              if (signal.aborted || active.current !== current) return;
              result = {
                artifacts: [{
                  name: outputFileName(input[0], 'translated', 'txt'),
                  blob: new Blob([translated], { type: 'text/plain;charset=utf-8' }),
                }],
                preview: translated,
              };
            } catch {
              if (!signal.aborted) finish({ state: 'error', message: 'Локальная модель не смогла перевести текст. Попробуйте изображение с более короткой надписью.' });
              return;
            }
          }
          finish({
            state: 'done',
            result,
            downloads: result.artifacts.map((artifact) => ({ ...artifact, url: URL.createObjectURL(artifact.blob) })),
          });
        } else if (data.type === 'error') {
          finish({ state: 'error', message: data.message });
        } else if (data.type === 'cancelled') {
          finish({ state: 'cancelled' });
        }
      };
      setPreview(false);
      setTask({ state: 'running', label: 'Готовим обработку…' });
      worker.postMessage({ type: 'run', job } satisfies WorkerRequest);
    } catch (error) {
      if (attempt && translation.current !== attempt) return;
      releaseTranslation();
      active.current?.worker.terminate();
      active.current = null;
      startLock.current = false;
      setTask(error instanceof DOMException && error.name === 'AbortError' ? { state: 'idle' }
        : { state: 'error', message: attempt && error instanceof Error && /[А-Яа-я]/.test(error.message) ? error.message : 'Не удалось начать обработку. Проверьте доступ к файлу и место сохранения.' });
    }
  }

  function cancel() {
    if (translation.current) {
      const attempt = translation.current;
      translation.current = null;
      attempt.controller.abort();
      attempt.device?.destroy();
      active.current?.worker.terminate();
      active.current = null;
      startLock.current = false;
      setTask({ state: 'cancelled' });
      return;
    }
    const job = active.current;
    if (!job) return;
    if (job.writingToDisk) {
      setTask({ state: 'cancelling' });
      job.worker.postMessage({ type: 'cancel' } satisfies WorkerRequest);
      job.timer = setTimeout(() => {
        job.worker.terminate();
        active.current = null;
        startLock.current = false;
        setTask({ state: 'cancelled' });
      }, 5000);
    } else {
      job.worker.terminate();
      active.current = null;
      startLock.current = false;
      setTask({ state: 'cancelled' });
    }
  }

  const ready = (inline ? !!draft.trim() : files.length >= minFiles) && !limitError && !fileError && !inspecting;
  const help = operation.source === 'image' ? 'До 40 Мп на файл, ' + fileSize(source.limit!) + ' суммарно'
    : source.limit ? 'До ' + fileSize(source.limit) + (multiple ? ' суммарно' : '')
    : canWrite ? 'Доступна прямая запись на диск' : 'Результат до ' + fileSize(MEDIA_LIMIT);
  const details = [
    info?.pages ? 'Страниц: ' + info.pages : '',
    info?.width && info.height ? info.width + ' × ' + info.height : '',
    info?.duration ? formatTime(info.duration) : '',
    ...(info?.codecs ?? []).map((codec) => codec.toUpperCase()),
  ].filter(Boolean);

  return <>
    <header className="topbar">
      <div className="topbar-inner">
        <a href="/" className="brand" aria-label="PDFwork — главная"><img src="/favicon.svg" alt="" width="38" height="38" /><span>PDFwork</span></a>
        <span className="privacy-tag"><LockKeyhole size={15} aria-hidden="true" /> Локальная обработка</span>
      </div>
    </header>

    <main className="page">
      <section className="intro">
        <h1>Инструменты для файлов</h1>
        <p>Объединяйте документы, конвертируйте изображения и редактируйте медиа.</p>
      </section>

      <nav className="category-tabs" aria-label="Тип файла">
        {categories.map(({ id, label }) => {
          const Icon = categoryIcons[id];
          return <button key={id} type="button" className={id === categoryId ? 'selected' : ''} aria-pressed={id === categoryId}
            disabled={busy} onClick={() => chooseCategory(id)}><Icon size={19} aria-hidden="true" />{label}</button>;
        })}
      </nav>

      <div className={"workbench" + (catalogOpen ? " catalog-open" : "")}>
        <section className="panel main-panel" aria-label="Действие и исходные файлы">
          <div className="tool-heading">
            <h2>{catalogOpen ? 'Каталог инструментов' : 'Выберите действие'}</h2>
            <div className="catalog-controls">
              <label className="tool-search">
                <Search size={16} aria-hidden="true" />
                <input type="search" aria-label="Найти инструмент" placeholder="Найти инструмент" value={search} disabled={busy}
                  onChange={(event) => setSearch(event.target.value)} />
              </label>
              <button type="button" className="catalog-button" aria-pressed={showAll} disabled={busy} onClick={() => {
                setSearch('');
                setShowAll(!showAll);
              }}><LayoutGrid size={16} aria-hidden="true" /> Все инструменты</button>
            </div>
          </div>
          <div className={"operation-grid" + (catalogOpen ? " catalog-grid" : "")} aria-label="Действия">
            {categoryOperations.map((item) => {
              const Icon = operationIcons[item.id] ?? categoryIcons[item.category];
              const selected = item.id === operationId;
              return <button key={item.id} type="button" className={'operation tool-' + item.category + (selected ? ' selected' : '')}
                aria-pressed={selected} disabled={busy} onClick={() => chooseTool(item)}>
                <span className="operation-icon"><Icon size={19} strokeWidth={1.8} aria-hidden="true" /></span>
                <span>{catalogOpen ? item.id === 'video-trim' ? 'Обрезать видео' : item.title : item.label}</span>
              </button>;
            })}
          </div>

          {categoryOperations.length === 0 && <p className="catalog-empty">По этому запросу инструменты не найдены.</p>}

          <div className="tool-source">
          {inline ? <section className="text-source" aria-label="Редактор входных данных">
            <div className="files-heading">
              <label htmlFor="source-text">{operation.source === 'html' ? 'Исходный HTML' : operationId === 'qr-generate' ? 'Текст или ссылка' : 'Исходный текст'}</label>
              <span>{fileSize(inputSize)} / {fileSize(inputLimit!)}</span>
            </div>
            <textarea id="source-text" value={draft} disabled={busy} spellCheck={operation.source !== 'html' && operationId !== 'qr-generate'}
              placeholder={operation.source === 'html' ? '<h1>Заголовок</h1>' : operationId === 'qr-generate' ? 'https://example.com' : 'Введите или вставьте текст'}
              onChange={(event) => updateDraft(event.target.value)} />
            <input ref={fileInput} type="file" aria-label="Выбрать текстовый файл" className="sr-only" disabled={busy}
              accept={source.accept} tabIndex={-1} onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importDraft(file);
                event.target.value = '';
              }} />
            <div className="text-source-actions">
              <button type="button" className="secondary-button" disabled={busy} onClick={() => fileInput.current?.click()}>
                <Upload size={16} aria-hidden="true" /> Открыть файл
              </button>
              {draft && <button type="button" className="text-button" disabled={busy} onClick={() => {
                updateDraft('');
                setDraftFileName('');
              }}>Очистить</button>}
              {draftFileName && <span title={draftFileName}>{draftFileName}</span>}
            </div>
          </section> : <>
          <div className="files-heading">
            <h2>{multiple ? 'Исходные файлы' : 'Исходный файл'}</h2>
            {files.length > 0 && <span>{fileSize(inputSize)}</span>}
          </div>
          {files.length > 0 && <ul className="file-list">
            {files.map((file, index) => <li key={file.name + '-' + file.lastModified + '-' + index} className="file-row">
              <span className="file-icon"><SourceIcon size={19} aria-hidden="true" /></span>
              <span className="file-meta"><strong title={file.name}>{file.name}</strong><small>{fileSize(file.size)}
                {!multiple && (inspecting ? ' · Читаем свойства…' : details.length > 0 ? ' · ' + details.join(' · ') : '')}
              </small></span>
              {multiple && <span className="file-order">
                <button className="icon-button" type="button" disabled={busy || index === 0} aria-label={'Поднять ' + file.name} onClick={() => moveFile(index, -1)}><ChevronUp size={17} /></button>
                <button className="icon-button" type="button" disabled={busy || index === files.length - 1} aria-label={'Опустить ' + file.name} onClick={() => moveFile(index, 1)}><ChevronDown size={17} /></button>
              </span>}
              <button className="icon-button" type="button" disabled={busy} aria-label={'Убрать ' + file.name} onClick={() => {
                setFiles((previous) => previous.filter((_, itemIndex) => itemIndex !== index));
                setTask({ state: 'idle' });
              }}><X size={17} /></button>
            </li>)}
          </ul>}

          <div className={'dropzone' + (dragging ? ' dragging' : '') + (files.length ? ' compact' : '')}
            onDragOver={(event) => event.preventDefault()}
            onDragEnter={(event) => { event.preventDefault(); if (!busy && event.dataTransfer.types.includes('Files') && ++dragDepth.current === 1) setDragging(true); }}
            onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
            onDrop={drop}>
            {files.length === 0 && <span className="drop-icon"><FolderOpen size={28} strokeWidth={1.65} aria-hidden="true" /></span>}
            <div className="drop-description">
              <strong>{multiple ? 'Перетащите файлы сюда' : 'Перетащите файл сюда'}</strong>
              <span>{source.formats} · {help}</span>
            </div>
            <input ref={fileInput} aria-label={multiple ? 'Выбрать файлы' : 'Выбрать файл'} className="sr-only" type="file"
              accept={source.accept} multiple={multiple} disabled={busy} tabIndex={-1}
              onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ''; }} />
            <button type="button" className="secondary-button" disabled={busy} onClick={() => fileInput.current?.click()}>
              <Upload size={17} aria-hidden="true" />{files.length ? multiple ? 'Добавить файлы' : 'Заменить файл' : multiple ? 'Выбрать файлы' : 'Выбрать файл'}
            </button>
          </div>
          </>}
          {(limitError || fileError) && <p role="alert" className="file-error"><CircleAlert size={16} /> {limitError || fileError}</p>}
          {primaryFile && operationId.endsWith('trim') && !fileError && !busy &&
            (preview ? <Preview file={primaryFile} video={categoryId === 'video'} onTime={updateValues} />
              : <button type="button" className="text-button preview-toggle" onClick={() => setPreview(true)}><Play size={15} /> Предпросмотр файла</button>)}
          </div>
        </section>

        <aside className="panel settings-panel" aria-label="Параметры и результат">
          <div className="settings-kicker"><SlidersHorizontal size={16} aria-hidden="true" /> Параметры</div>
          <h2>{operation.title}</h2>
          <p className="tool-description">{operation.description}</p>
          {operationId === 'photo-translate' && !canTranslateOnDevice() &&
            <p className="field-note disk-note">Локальный переводчик доступен в поддерживаемых версиях настольных Chrome и Edge.</p>}
          <form onSubmit={start}>
            <fieldset disabled={busy}>
              <legend className="sr-only">Настройки операции</legend>
              <Settings operation={operationId} values={values} onChange={updateValues} info={info}
                canWrite={canWrite} writeToDisk={writeToDisk} onWriteToDisk={setDiskChoice} />
            </fieldset>
            {busy && task.state !== 'choosing'
              ? <button type="button" className="cancel-button" disabled={task.state === 'cancelling'} onClick={cancel}>Отменить обработку</button>
              : <button type="submit" className="primary-button" disabled={busy || !ready}><Play size={17} aria-hidden="true" /> Запустить обработку</button>}
          </form>
          {!busy && task.state === 'idle' && !ready && !fileError && !limitError && <p className="helper">{inspecting ? 'Читаем свойства файла…' : inline ? 'Введите текст или откройте файл.' : minFiles === 2 ? 'Добавьте минимум два PDF-файла.' : 'Выберите исходный файл для обработки.'}</p>}
          <TaskStatus task={task} inputSize={inputSize} showImage={operationId === 'qr-generate'} />
          <SettingsGuide operation={operationId} info={info} />
          <div className="privacy-note"><ShieldCheck size={20} aria-hidden="true" /><span>Файлы остаются на вашем устройстве.</span></div>
        </aside>
      </div>

      <footer className="footer"><span><FileIcon size={15} aria-hidden="true" /> Оставьте вкладку открытой до конца обработки</span></footer>
    </main>
  </>;
}







