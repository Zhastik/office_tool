import {
  ADTS, FLAC, MATROSKA, MP3, MP4, OGG, QTFF, WAVE, WEBM, BlobSource, Conversion, EncodedPacketSink, Input, Mp4OutputFormat, OggOutputFormat, Output,
  Quality, StreamTarget, WavOutputFormat, WebMOutputFormat, type StreamTargetChunk,
} from 'mediabunny';
import {
  MEDIA_LIMIT, MIB, fileSize, mediaOutput, parseTime,
  type Category, type FileInfo, type Job, type JobContext, type Result,
} from '../domain';

const BLOCK = 2 * MIB;

function localInput(file: File) {
  return new Input({ formats: [MP4, QTFF, WEBM, MATROSKA, MP3, WAVE, OGG, FLAC, ADTS], source: new BlobSource(file, { maxCacheSize: 8 * MIB }) });
}

async function checkTracks(input: Input, video: boolean) {
  const tracks = await input.getTracks();
  const pictures = tracks.filter((track) => track.isVideoTrack());
  const sounds = tracks.filter((track) => track.isAudioTrack());
  const supported = video ? pictures.length === 1 && sounds.length <= 1 : pictures.length === 0 && sounds.length === 1;
  if (!supported || tracks.length !== pictures.length + sounds.length) {
    throw new Error(video
      ? 'Выберите видео с одной видеодорожкой и максимум одной звуковой дорожкой, без дополнительных дорожек.'
      : 'Выберите файл с одной звуковой дорожкой.');
  }
  return { tracks, picture: pictures[0], sound: sounds[0] };
}

export async function inspectMedia(file: File, category: Category): Promise<FileInfo> {
  const input = localInput(file);
  try {
    const { tracks, picture } = await checkTracks(input, category === 'video');
    const [first, end, width, height, codecs] = await Promise.all([
      input.getFirstTimestamp(tracks),
      input.getDurationFromMetadata(tracks, { skipLiveWait: true }),
      picture?.getDisplayWidth(),
      picture?.getDisplayHeight(),
      Promise.all(tracks.map((track) => track.getCodec())),
    ]);
    return { duration: end === null ? undefined : Math.max(0, end - first), width, height, codecs: codecs.map((codec) => codec ?? '?') };
  } finally {
    input.dispose();
  }
}

function inMemoryMedia() {
  const blocks: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  return {
    write({ position, data }: StreamTargetChunk) {
      const end = position + data.byteLength;
      if (end > MEDIA_LIMIT) {
        throw new Error('Результат больше ' + fileSize(MEDIA_LIMIT) + '. Включите сохранение на диск или сократите фрагмент.');
      }
      while (blocks.length * BLOCK < end) blocks.push(new Uint8Array(BLOCK));
      for (let offset = 0; offset < data.length;) {
        const absolute = position + offset;
        const inBlock = absolute % BLOCK;
        const size = Math.min(BLOCK - inBlock, data.length - offset);
        blocks[Math.floor(absolute / BLOCK)].set(data.subarray(offset, offset + size), inBlock);
        offset += size;
      }
      length = Math.max(length, end);
    },
    asBlob(mime: string) {
      return new Blob(blocks.map((block, index) => block.subarray(0, Math.min(BLOCK, length - index * BLOCK))), { type: mime });
    },
  };
}

export async function processMedia(job: Job, { signal, progress }: JobContext): Promise<Result> {
  const { operation, files: [file], options, destination } = job;
  const video = operation.startsWith('video');
  const trimming = operation.endsWith('trim');
  const copy = operation === 'video-trim';
  const webm = operation === 'video-compress' && options.videoFormat === 'webm';
  const wav = !video && options.audioFormat === 'wav';
  const input = localInput(file);
  let writer: FileSystemWritableFileStream | undefined;
  let conversion: Conversion | undefined;
  let committed = false;
  const cancel = () => { void conversion?.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel);
  try {
    progress('Проверяем дорожки и кодеки…');
    const { tracks, picture, sound } = await checkTracks(input, video);
    const [first, end] = await Promise.all([
      input.getFirstTimestamp(tracks),
      input.computeDuration(tracks, { skipLiveWait: true }),
    ]);
    const duration = end - first;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('У файла нет доступного интервала воспроизведения.');
    const startAt = trimming ? parseTime(options.start) : 0;
    const endAt = trimming && options.end.trim() ? parseTime(options.end) : duration;
    if (startAt >= endAt || endAt > duration + 0.001) {
      throw new Error('Укажите начало раньше конца в пределах длительности файла.');
    }

    const trimEnd = Math.min(first + endAt, end);
    let trimStart = first + startAt;
    let clipNote: string | undefined;
    if (copy && picture) {
      const packets = new EncodedPacketSink(picture);
      const settings = { verifyKeyPackets: true, skipLiveWait: true };
      let key = await packets.getKeyPacket(trimStart, settings) ?? await packets.getFirstKeyPacket(settings);
      if (key && key.timestamp + 0.000001 < trimStart) key = await packets.getNextKeyPacket(key, settings);
      if (!key || key.timestamp + key.duration > trimEnd) {
        throw new Error('В интервале нет целого ключевого кадра. Увеличьте длительность фрагмента.');
      }
      trimStart = key.timestamp;
      const actual = Math.max(0, trimStart - first).toLocaleString('ru', { maximumFractionDigits: 3 });
      clipNote = 'Начало фрагмента в исходнике — ' + actual + ' с.';
    }

    let largeWav = false;
    if (wav && sound) {
      const pcmSize = (endAt - startAt) * await sound.getSampleRate() * await sound.getNumberOfChannels() * 2;
      if (!destination && pcmSize > MEDIA_LIMIT) {
        throw new Error('Ожидаемый WAV больше ' + fileSize(MEDIA_LIMIT) + '. Включите сохранение на диск или выберите Ogg Opus.');
      }
      largeWav = pcmSize >= 0xfff00000;
    }

    const memory = destination ? undefined : inMemoryMedia();
    const stream = new WritableStream<StreamTargetChunk>({
      write(chunk) {
        signal.throwIfAborted();
        return writer ? writer.write(chunk) : memory?.write(chunk);
      },
    });
    const target = new StreamTarget(stream, { chunked: true, chunkSize: BLOCK });
    let bytes = 0;
    target.onwrite = (_, endPosition) => { bytes = Math.max(bytes, endPosition); };
    const format = webm ? new WebMOutputFormat() : video
      ? new Mp4OutputFormat({ fastStart: destination ? 'fragmented' : false, minimumFragmentDuration: 2 })
      : wav ? new WavOutputFormat({ large: largeWav }) : new OggOutputFormat();
    const output = new Output({ format, target });

    const requestedHeight = picture && !copy ? Math.min(options.videoHeight, await picture.getDisplayHeight()) : 0;
    const height = requestedHeight ? Math.max(2, Math.floor(requestedHeight / 2) * 2) : undefined;

    conversion = await Conversion.init({
      input,
      output,
      video: video && !copy ? { codec: webm ? 'vp8' : 'avc', height, quality: new Quality({ bitrate: Math.round(options.bitrate * 1_000_000) }), forceTranscode: true } : undefined,
      audio: copy ? undefined : {
        codec: video && !webm ? 'aac' : wav ? 'pcm-s16' : 'opus',
        quality: !wav && (!video || webm) ? new Quality({ bitrate: 128_000 }) : undefined,
      },
      // Time bounds are relative to the beginning displayed in the UI.
      trim: trimming ? { start: trimStart, end: trimEnd } : undefined,
      copy: copy ? { mode: 'forced', boundaryPolicy: 'shrink', shiftTolerance: Infinity } : undefined,
      tags: {},
      showWarnings: false,
    });
    signal.throwIfAborted();
    if (!conversion.isValid || conversion.discardedTracks.length || conversion.utilizedTracks.length !== tracks.length) {
      const reason = conversion.discardedTracks[0]?.reason;
      if (!copy && reason === 'no_encodable_target_codec') {
        throw new Error('Браузер не может закодировать выбранный формат. Выберите другой формат или обновите браузер.');
      }
      if (!copy && reason === 'undecodable_source_codec') {
        throw new Error('Браузер не может декодировать одну из дорожек. Попробуйте файл в другом формате.');
      }
      throw new Error(copy
        ? 'Этот фрагмент или набор дорожек нельзя сохранить в MP4 копированием. Измените интервал или выберите сжатие видео.'
        : 'Браузер не поддерживает декодирование исходника или кодирование выбранного формата. Попробуйте другой формат либо браузер.');
    }

    progress('Подготавливаем сохранение…', 0);
    if (destination) {
      const existing = await destination.getFile();
      if (existing.name === file.name && existing.size === file.size) {
        throw new Error('Выберите другое имя выходного файла, чтобы сохранить исходник.');
      }
      writer = await destination.createWritable({ keepExistingData: false });
    }

    signal.throwIfAborted();
    conversion.onProgress = (fraction) => progress(copy ? 'Копируем дорожки…' : 'Кодируем медиа…', Math.min(0.98, fraction));
    await conversion.execute();
    signal.throwIfAborted();
    if (bytes < 1) throw new Error('В выбранном интервале нет данных для сохранения.');
    progress('Завершаем запись…', 0.99);
    const { name, mime } = mediaOutput(job);
    if (writer && destination) {
      await writer.close();
      committed = true;
      return {
        artifacts: [],
        saved: { name: destination.name, bytes },
        note: largeWav ? 'Файл сохранён в RF64 для поддержки размера свыше 4 ГБ.' : clipNote,
      };
    }

    if (!memory) throw new Error('Не удалось подготовить результат.');
    return { artifacts: [{ name, blob: memory.asBlob(mime) }], note: clipNote };
  } finally {
    signal.removeEventListener('abort', cancel);
    if (conversion && (conversion.state === 'idle' || conversion.state === 'executing')) await conversion.cancel().catch(() => {});
    if (writer && !committed) await writer.abort().catch(() => {});
    input.dispose();
  }
}






