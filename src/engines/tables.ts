import { read, utils, write } from 'xlsx';
import { type Options } from '../domain';
import { readOfficeZip } from './office';

export const CSV_MIME = 'text/csv;charset=utf-8';
const maxRows = 20_000;
const maxColumns = 100;

function validate(rows: string[][]) {
  if (rows.length > maxRows || rows.some((row) => row.length > maxColumns)) {
    throw new Error('Предел таблицы — 20 000 строк и 100 столбцов.');
  }
  if (!rows.some((row) => row.some((cell) => cell.trim()))) throw new Error('В выбранных данных нет непустых ячеек.');
  return rows;
}

export function parseCsv(text: string, delimiter: Options['delimiter']) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closed = false;
  const source = text.replace(/^\uFEFF/, '');
  function addCell() {
    row.push(cell);
    if (row.length > maxColumns) throw new Error('В CSV больше 100 столбцов.');
    cell = '';
    closed = false;
  }
  function addRow() {
    addCell();
    rows.push(row);
    if (rows.length > maxRows) throw new Error('В CSV больше 20 000 строк.');
    row = [];
  }
  for (let i = 0; i < source.length; i++) {
    const character = source[i];
    if (quoted) {
      if (character === '"' && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (character === '"') {
        quoted = false;
        closed = true;
      } else {
        cell += character;
      }
    } else if (character === delimiter) {
      addCell();
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[i + 1] === '\n') i++;
      addRow();
    } else if (character === '"' && !cell && !closed) {
      quoted = true;
    } else if (closed || character === '"') {
      throw new Error('Проверьте кавычки в CSV и выбранный разделитель.');
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error('Одна из ячеек CSV содержит незакрытые кавычки.');
  if (cell || row.length || closed) addRow();
  return validate(rows);
}

export async function readCsv(file: File, delimiter: Options['delimiter']) {
  const bytes = await file.arrayBuffer();
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Сохраните исходный CSV в кодировке UTF-8.');
  }
  return parseCsv(source, delimiter);
}

export function csvBlob(rows: string[][], delimiter: Options['delimiter']) {
  const formatted = rows.map((row) => row.map((value) => {
    // Preserve signed numeric values while escaping strings that spreadsheet apps may interpret as formulas.
    const safe = /^[\s\uFEFF]*[=+@-]/.test(value) && !/^[+-]?\d+(?:[.,]\d+)?$/.test(value.trim()) ? "'" + value : value;
    return '"' + safe.replaceAll('"', '""') + '"';
  }).join(delimiter)).join('\r\n');
  return new Blob(['\uFEFF', formatted, '\r\n'], { type: CSV_MIME });
}

export function xlsxBlob(sheets: { name: string; rows: string[][] }[]) {
  const workbook = utils.book_new();
  for (const { name, rows } of sheets) {
    validate(rows);
    utils.book_append_sheet(workbook, utils.aoa_to_sheet(rows), name);
  }
  const data = write(workbook, { bookType: 'xlsx', type: 'array', compression: true }) as ArrayBuffer;
  return new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export async function readWorkbook(file: File, options: Options) {
  const { bytes } = await readOfficeZip(file, () => false);
  const workbook = read(bytes, { type: 'array', cellFormula: false, cellHTML: false, bookVBA: false });
  const name = workbook.SheetNames[options.sheet - 1];
  if (!name) throw new Error('В книге доступно листов: ' + workbook.SheetNames.length + '. Проверьте номер листа.');
  const sheet = workbook.Sheets[name];
  const range = options.tableRange.trim().toUpperCase();
  if (range && !/^[A-Z]{1,3}[1-9]\d{0,6}(?::[A-Z]{1,3}[1-9]\d{0,6})?$/.test(range)) {
    throw new Error('Укажите диапазон ячеек в формате A1:D20.');
  }
  const used = utils.decode_range(sheet['!ref'] ?? 'A1');
  const selection = range ? utils.decode_range(range) : used;
  if (selection.e.r < selection.s.r || selection.e.c < selection.s.c ||
    selection.e.r - selection.s.r + 1 > maxRows || selection.e.c - selection.s.c + 1 > maxColumns) {
    throw new Error('Выберите диапазон до 20 000 строк и 100 столбцов.');
  }
  const rows = utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '', blankrows: true, range: selection });
  return { name, rows: validate(rows) };
}

export function rowsFromOcr(text: string) {
  return validate(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map((line) => line.split(/\s{2,}|\t+|\s*[|;]\s*/).map((cell) => cell.trim())));
}

function validDate(source: string) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(source);
  const short = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/.exec(source);
  if (!iso && !short) return false;
  const [year, month, day] = (iso ? iso.slice(1) : short!.slice(1).reverse()).map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function amountValue(source: string) {
  const text = source.trim().replace(/\s*(?:₽|руб\.?|RUB|USD|EUR|€|\$)$/i, '').replace(/\s+/g, '');
  if (!/^[+-]?\d+(?:[.,]\d{1,2})?$/.test(text)) return undefined;
  return text.replace(',', '.');
}

export function statementRows(input: string[][]) {
  const headings = ['Дата', 'Описание', 'Сумма'];
  const rows = [headings];
  const unparsed: string[][] = [];
  let columns: { date: number; description: number; amount: number } | undefined;
  for (const row of input) {
    const cells = row.map((item) => item.trim());
    if (!cells.some(Boolean)) continue;
    const normal = cells.map((cell) => cell.toLowerCase());
    const date = normal.findIndex((cell) => /^(?:дата(?: операции)?|date|transaction date)$/.test(cell));
    const description = normal.findIndex((cell) => /^(?:описание|назначение(?: платежа)?|операция|description|details)$/.test(cell));
    const amount = normal.findIndex((cell) => /^(?:сумма(?: операции)?|amount|transaction amount)(?:\s*\([^)]*\))?$/.test(cell));
    if (date >= 0 && description >= 0 && amount >= 0) {
      columns = { date, description, amount };
      continue;
    }

    const indexes = columns ?? (cells.length === 3 ? { date: 0, description: 1, amount: 2 } : undefined);
    if (indexes) {
      const transactionDate = cells[indexes.date] ?? '';
      const transactionAmount = amountValue(cells[indexes.amount] ?? '');
      const details = cells[indexes.description];
      if (validDate(transactionDate) && transactionAmount && details) {
        rows.push([transactionDate, details, transactionAmount]);
        continue;
      }
    }
    unparsed.push(cells);
  }
  return { rows, unparsed };
}


