import { extraTools } from './extra-tools';
import type { Job, JobContext, Result, WorkerRequest, WorkerResponse } from './domain';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const emit = (message: WorkerResponse) => scope.postMessage(message);
let controller: AbortController | undefined;

async function run(job: Job, context: JobContext): Promise<Result> {
  const { operation, files } = job;
  if (!files.length || files.some((file) => file.size === 0)) throw new Error('Выберите непустой файл.');
  if (extraTools.some((tool) => tool.id === operation)) return (await import('./engines/extended')).runExtended(job, context);
  if (operation === 'pdf-text' || operation === 'pdf-ocr') return (await import('./engines/pdf-reader')).readPdf(job, context);
  if (operation.startsWith('pdf-')) return (await import('./engines/pdf')).processPdf(job, context);
  if (operation.startsWith('image-')) return (await import('./engines/image')).processImage(job, context);
  return (await import('./engines/media')).processMedia(job, context);
}

function errorMessage(error: unknown) {
  if (!(error instanceof Error)) return 'Обработка завершилась с ошибкой. Проверьте файл и повторите попытку.';
  if (error.name === 'NotAllowedError') return 'Браузер не разрешил запись. Выберите доступную папку или файл.';
  if (error.name === 'QuotaExceededError') return 'Недостаточно места для сохранения результата.';
  if (/password|encrypted/i.test(error.message) || error.name === 'PasswordException') return 'Файл защищён паролем. Откройте незашифрованную копию.';
  if (error.name === 'NotReadableError') return 'Не удалось прочитать файл. Выберите его повторно.';
  if (/[А-Яа-яЁё]/.test(error.message)) return error.message;
  if (error.name === 'UnsupportedInputFormatError' || error.name === 'InvalidPDFException') {
    return 'Формат файла не поддерживается или файл повреждён.';
  }
  return 'Не удалось обработать файл. Проверьте его формат, доступное место и поддержку кодеков в браузере.';
}

scope.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  if (data.type === 'cancel') {
    controller?.abort();
    return;
  }
  if (controller) return;
  controller = new AbortController();
  try {
    if (data.type === 'inspect') {
      const { file, category } = data;
      const info = category === 'pdf' ? await (await import('./engines/pdf-reader')).inspectPdf(file)
        : category === 'image' ? await (await import('./engines/image')).inspectImage(file)
        : await (await import('./engines/media')).inspectMedia(file, category);
      emit({ type: 'info', info });
      return;
    }

    let lastTime = 0;
    let lastLabel = '';
    const result = await run(data.job, {
      signal: controller.signal,
      progress(label, fraction) {
        const now = performance.now();
        if (label === lastLabel && now - lastTime < 85) return;
        lastLabel = label;
        lastTime = now;
        emit({ type: 'progress', label, fraction });
      },
    });
    emit(controller.signal.aborted && !result.saved ? { type: 'cancelled' } : { type: 'result', result });
  } catch (error) {
    if (controller.signal.aborted) emit({ type: 'cancelled' });
    else emit({ type: 'error', message: errorMessage(error) });
  } finally {
    controller = undefined;
  }
};


