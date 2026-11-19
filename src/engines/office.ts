import { strToU8, unzipSync, zipSync } from 'fflate';
import { parseDocument } from 'htmlparser2';
import { MIB } from '../domain';
import { DOCUMENT_LIMIT_MIB } from '../extra-tools';

type Node = ReturnType<typeof parseDocument>['children'][number];
type Element = Extract<Node, { attribs: Record<string, string> }>;

function name(node: Element) {
  return node.name.split(':').at(-1)!;
}

function elements(nodes: Node[], tag?: string): Element[] {
  return nodes.filter((node): node is Element => 'attribs' in node && (!tag || name(node) === tag));
}

function descendants(nodes: Node[], tag: string): Element[] {
  return elements(nodes).flatMap((node) => name(node) === tag ? [node] : descendants(node.children, tag));
}

export async function readOfficeZip(file: File, include: (entry: string) => boolean) {
  if (file.size > DOCUMENT_LIMIT_MIB * MIB) throw new Error('Предел для документа Office — 32 МБ.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let size = 0;
  let entries = 0;
  const parts = unzipSync(bytes, { filter: ({ name, originalSize }) => {
    size += originalSize;
    entries++;
    if (size > 128 * MIB || entries > 3000) throw new Error('Внутренние данные документа Office превышают предел обработки.');
    return include(name);
  } });
  return { bytes, parts };
}

const decoder = new TextDecoder();

function xml(data: Uint8Array | undefined) {
  if (!data) throw new Error('В файле отсутствует нужная часть документа Office.');
  const source = decoder.decode(data);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new Error('Документ содержит неподдерживаемые объявления XML.');
  return parseDocument(source, { xmlMode: true }).children;
}

function plain(nodes: Node[]): string {
  return nodes.map((node) => node.type === 'text' ? node.data : 'children' in node ? plain(node.children) : '').join('');
}

function paragraph(node: Element): string {
  return elements(node.children).map((part) => {
    if (name(part) === 't') return plain(part.children);
    if (name(part) === 'tab') return '\t';
    if (['br', 'cr'].includes(name(part))) return '\n';
    if (['del', 'rPr', 'pPr'].includes(name(part))) return '';
    return paragraph(part);
  }).join('');
}

export async function readDocx(file: File) {
  const { parts } = await readOfficeZip(file, (entry) => entry === 'word/document.xml');
  const body = descendants(xml(parts['word/document.xml']), 'body')[0];
  if (!body) throw new Error('Не найдено содержимое DOCX.');
  const lines: string[] = [];
  const tables: string[][][] = [];
  for (const node of elements(body.children)) {
    if (name(node) === 'p') lines.push(paragraph(node));
    if (name(node) === 'tbl') {
      const rows = elements(node.children, 'tr').map((row) =>
        elements(row.children, 'tc').map((cell) => elements(cell.children, 'p').map(paragraph).join('\n')),
      );
      if (rows.length) tables.push(rows);
      lines.push(...rows.map((row) => row.join('  |  ')));
    }
  }
  if (!lines.some((line) => line.trim())) throw new Error('В документе нет доступного текста или таблиц.');
  return { lines, tables };
}

export async function readSlides(file: File) {
  const { parts } = await readOfficeZip(file, (entry) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(entry) ||
    entry === 'ppt/presentation.xml' || entry === 'ppt/_rels/presentation.xml.rels',
  );
  const rels = new Map(descendants(xml(parts['ppt/_rels/presentation.xml.rels']), 'Relationship')
    .map(({ attribs }) => [attribs.Id, 'ppt/' + (attribs.Target ?? '').replace(/^\/ppt\//, '')]));
  const references = descendants(xml(parts['ppt/presentation.xml']), 'sldId');
  if (!references.length) throw new Error('В презентации нет слайдов.');
  if (references.length > 50) throw new Error('За одну операцию можно экспортировать до 50 слайдов.');
  return references.map(({ attribs }) => {
    const path = rels.get(attribs['r:id']) ?? '';
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(path)) throw new Error('Не удалось найти один из слайдов.');
    return descendants(xml(parts[path]), 'p').map(paragraph).filter((line) => line.trim());
  });
}

export function escapeMarkup(text: string) {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? ''),
  );
}

export function docxBlob(sections: string[], paper: 'a4' | 'letter') {
  const wordNs = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const officeRel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const paragraphXml = (line: string) => '<w:p><w:r><w:t xml:space="preserve">' + escapeMarkup(line.replace(/\t/g, '    ')) + '</w:t></w:r></w:p>';
  const body = sections.map((section) => section.replace(/\r\n?/g, '\n').split('\n').map(paragraphXml).join(''))
    .join('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
  const page = paper === 'letter' ? 'w:w="12240" w:h="15840"' : 'w:w="11905" w:h="16838"';
  const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const archive = zipSync({
    '[Content_Types].xml': strToU8(xmlHeader + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8(xmlHeader + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + officeRel + '/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(xmlHeader + '<w:document xmlns:w="' + wordNs + '"><w:body>' + body + '<w:sectPr><w:pgSz ' + page + '/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000"/></w:sectPr></w:body></w:document>'),
  }, { level: 3 });
  return new Blob([new Uint8Array(archive)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

export function textFromHtml(source: string) {
  const hidden = new Set(['head', 'script', 'style', 'noscript', 'iframe', 'object', 'template', 'svg']);
  const block = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'pre', 'section', 'tr']);
  function walk(node: Node): string {
    if (node.type === 'text') return node.data.replace(/\s+/g, ' ');
    if (!('attribs' in node) || hidden.has(node.name) || 'hidden' in node.attribs) return '';
    if (node.name === 'br') return '\n';
    const content = node.children.map(walk).join('');
    if (node.name === 'li') return '\n• ' + content.trim();
    if (node.name === 'td' || node.name === 'th') return content.trim() + '  |  ';
    return block.has(node.name) ? '\n' + content.trim() + '\n' : content;
  }
  return parseDocument(source).children.map(walk).join('').replace(/ +\| +\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}


