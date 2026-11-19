export const extraTools = [
  { id: 'image-docx', category: 'document', source: 'image', label: 'Фото в Word', description: 'Распознайте текст на изображении и сохраните его как редактируемый DOCX.' },
  { id: 'photo-translate', category: 'image', source: 'image', label: 'Перевести фото', description: 'Сначала распознайте текст с фотографии, затем переведите его с помощью модели браузера.' },
  { id: 'qr-scan', category: 'code', source: 'image', label: 'Прочитать QR-код', description: 'Извлеките содержимое QR-кода с фотографии или скриншота.' },
  { id: 'barcode-scan', category: 'code', source: 'image', label: 'Прочитать штрихкод', description: 'Извлеките значение линейного штрихкода с фотографии.' },
  { id: 'pdf-docx', category: 'document', source: 'pdf', label: 'PDF в Word', description: 'Перенесите текстовый слой выбранных страниц PDF в редактируемый DOCX.' },
  { id: 'text-pdf', category: 'document', source: 'text', label: 'Текст в PDF', description: 'Вставьте текст или выберите TXT. Получите PDF с выделяемым текстом.' },
  { id: 'text-docx', category: 'document', source: 'text', label: 'Текст в Word', description: 'Сохраните введённый текст в редактируемом DOCX.' },
  { id: 'image-invert', category: 'image', source: 'image', label: 'Инвертировать цвета', description: 'Инвертируйте цвета изображения. Прозрачность поддерживается в PNG и WebP.' },
  { id: 'text-image', category: 'image', source: 'text', label: 'Текст в изображение', description: 'Разместите введённый текст на белом фоне и скачайте PNG.' },
  { id: 'image-pdf', category: 'image', source: 'image', files: 20, label: 'Изображения в PDF', description: 'Соберите изображения в PDF. Порядок файлов определяет порядок страниц.' },
  { id: 'docx-pdf', category: 'document', source: 'docx', label: 'Word в PDF', description: 'Сохраните абзацы и содержимое таблиц DOCX в PDF с единым оформлением.' },
  { id: 'pdf-jpg', category: 'image', source: 'pdf', label: 'PDF в JPG', description: 'Сохраните каждую выбранную страницу PDF как отдельное изображение JPEG.' },
  { id: 'image-xlsx', category: 'table', source: 'image', label: 'Фото в Excel', description: 'Распознайте текст и попробуйте разделить строки на ячейки по видимым пробелам и разделителям.' },
  { id: 'qr-generate', category: 'code', source: 'text', label: 'Создать QR-код', description: 'Закодируйте URL или текст и скачайте QR-код в PNG.' },
  { id: 'docx-jpg', category: 'document', source: 'docx', label: 'Word в JPG', description: 'Сохраните абзацы и таблицы DOCX как изображения страниц с единым оформлением.' },
  { id: 'pdf-xlsx', category: 'table', source: 'pdf', label: 'PDF в Excel', description: 'Распределите текстовый слой PDF по столбцам на основе расположения текста на странице.' },
  { id: 'xlsx-jpg', category: 'table', source: 'xlsx', label: 'Excel в JPG', description: 'Разложите ячейки выбранного листа XLSX по страницам и сохраните их в JPEG.' },
  { id: 'pdf-csv', category: 'table', source: 'pdf', label: 'PDF в CSV', description: 'Преобразуйте текстовые строки PDF в CSV с приблизительным восстановлением столбцов.' },
  { id: 'html-pdf', category: 'document', source: 'html', label: 'HTML в PDF', description: 'Преобразуйте заголовки, абзацы, списки и текст таблиц HTML в PDF.' },
  { id: 'pdf-html', category: 'document', source: 'pdf', label: 'PDF в HTML', description: 'Сохраните читаемый текстовый слой PDF как автономную HTML-страницу.' },
  { id: 'batch-ocr', category: 'image', source: 'image', files: 20, label: 'Пакетное OCR', description: 'Распознайте несколько изображений и объедините результат в один TXT с заголовками файлов.' },
  { id: 'docx-xlsx', category: 'table', source: 'docx', label: 'Word в Excel', description: 'Перенесите каждую таблицу DOCX на отдельный лист XLSX. Абзацы сохраняются в один столбец, если в документе нет таблиц.' },
  { id: 'pptx-pdf', category: 'document', source: 'pptx', label: 'PowerPoint в PDF', description: 'Сохраните текстовые блоки слайдов PPTX в PDF в порядке презентации.' },
  { id: 'csv-xlsx', category: 'table', source: 'csv', label: 'CSV в Excel', description: 'Импортируйте CSV как лист XLSX. Значения сохраняются как текст, включая начальные нули.' },
  { id: 'xlsx-csv', category: 'table', source: 'xlsx', label: 'Excel в CSV', description: 'Сохраните отображаемые значения ячеек выбранного листа в CSV.' },
  { id: 'xlsx-pdf', category: 'table', source: 'xlsx', label: 'Excel в PDF', description: 'Сохраните сетку ячеек выбранного листа XLSX в PDF.' },
  { id: 'statement-export', category: 'table', source: 'statement', label: 'Банковская выписка', description: 'Извлеките операции из CSV или текстового PDF и сохраните таблицу дат, описаний и сумм.' },
] as const;

export type ExtraOperation = (typeof extraTools)[number]['id'];

export const PDF_EXPORT_PAGE_LIMIT = 25;
export const DOCUMENT_LIMIT_MIB = 32;
export const TEXT_LIMIT = 256 * 1024;
export const QR_TEXT_LIMIT = 1000;

