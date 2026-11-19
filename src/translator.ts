import type { Options } from './domain';

interface DeviceTranslator {
  translate(content: string, options?: { signal: AbortSignal }): Promise<string>;
  destroy(): void;
}

type Pair = { sourceLanguage: string; targetLanguage: string };
interface TranslatorAPI {
  availability(pair: Pair): Promise<'available' | 'downloadable' | 'downloading' | 'unavailable'>;
  create(options: Pair & { signal: AbortSignal; monitor: (target: EventTarget) => void }): Promise<DeviceTranslator>;
}

function api() {
  return (window as Window & { Translator?: TranslatorAPI }).Translator;
}

export function canTranslateOnDevice() {
  return !!api();
}

export async function prepareTranslator(
  direction: Options['translationDirection'],
  signal: AbortSignal,
  progress: (label: string, fraction?: number) => void,
) {
  const translator = api();
  if (!translator) throw new Error('Для перевода требуется настольный Chrome или Edge с локальным переводчиком.');
  const pair = direction === 'en-ru' ? { sourceLanguage: 'en', targetLanguage: 'ru' } : { sourceLanguage: 'ru', targetLanguage: 'en' };
  if (await translator.availability(pair) === 'unavailable') throw new Error('Эта языковая пара недоступна в браузере на данном устройстве.');
  signal.throwIfAborted();
  try {
    return await translator.create({
      ...pair,
      signal,
      monitor(target) {
        target.addEventListener('downloadprogress', (event) => {
          progress('Загружаем языковой пакет браузера…', Math.min(0.99, (event as ProgressEvent).loaded));
        });
      },
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error('Не удалось подготовить локальный переводчик. Проверьте доступность языкового пакета в браузере.');
  }
}

