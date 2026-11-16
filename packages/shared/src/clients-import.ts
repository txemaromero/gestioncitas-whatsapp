/**
 * F23: import of a clinic's existing clients from a CSV file (exported from Excel or another
 * system). Pure and isomorphic: the panel decodes the file and shows a preview, the server parses
 * it again before saving. Same rules as creating a client in the panel (name 2–80 characters,
 * phone normalised to E.164 with +34 by default, valid email in lower case, notes up to 2000).
 */
import { normalizePhone } from './phone';
import { isValidEmail, normalizeText } from './text';

export const CLIENT_IMPORT_MAX_ROWS = 2000;
/** Size of the decoded text accepted by the server. */
export const CLIENT_IMPORT_MAX_CHARS = 1_000_000;

export interface ImportedClientRow {
  /** Row in the spreadsheet (the header is row 1). */
  row: number;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
}

export interface SkippedClientRow {
  row: number;
  name: string | null;
  reason: string;
}

export interface ParsedClientsCsv {
  /** Data rows that are not completely empty. */
  total: number;
  rows: ImportedClientRow[];
  skipped: SkippedClientRow[];
  /** Columns recognised (field → header as written in the file) and the ones ignored. */
  columns: Partial<Record<'name' | 'surname' | 'phone' | 'email' | 'notes', string[]>>;
  ignoredColumns: string[];
}

/**
 * Text of an uploaded file: UTF-8 when valid (with or without BOM), otherwise Windows-1252, the
 * encoding Excel uses in Spain for "CSV (delimitado por comas)".
 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** `;` (Excel in Spain), `,` or tab, whichever appears most in the header line outside quotes. */
export function detectDelimiter(text: string): string {
  const counts = new Map<string, number>([[';', 0], [',', 0], ['\t', 0]]);
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '\n' || char === '\r')) break;
    else if (!quoted && counts.has(char)) counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let best = ',';
  let max = 0;
  for (const [delimiter, count] of counts) {
    if (count > max) {
      best = delimiter;
      max = count;
    }
  }
  return best;
}

/** Byte order mark that Excel puts at the start of "CSV UTF-8" files. */
const BOM = String.fromCharCode(0xfeff);
const withoutBom = (text: string) => (text.startsWith(BOM) ? text.slice(1) : text);

/** RFC 4180 CSV: quoted fields with `""` escapes and line breaks inside quotes, CRLF or LF. */
export function parseCsv(input: string, delimiter = detectDelimiter(withoutBom(input))): string[][] {
  const text = withoutBom(input);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

type Field = 'name' | 'surname' | 'phone' | 'email' | 'notes';

/** Header names (normalised: lower case, no accents, letters and digits only) of each field. */
const HEADERS: Record<Field, string[]> = {
  name: ['nombre', 'name', 'nombrecompleto', 'nombreyapellidos', 'cliente', 'paciente', 'fullname'],
  surname: ['apellidos', 'apellido', 'primerapellido', 'segundoapellido', 'apellido1', 'apellido2', 'surname', 'lastname'],
  // Mobile first: it is the one WhatsApp uses.
  phone: ['movil', 'telefonomovil', 'whatsapp', 'celular', 'mobile', 'telefono', 'tel', 'phone', 'telefonofijo'],
  email: ['email', 'correo', 'correoelectronico', 'mail', 'emailaddress'],
  notes: ['notas', 'notes', 'observaciones', 'comentarios'],
};

const headerKey = (value: string) => normalizeText(value).replace(/[^a-z0-9]/g, '');

const tidy = (value: string | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

/** Parses and validates a clients CSV. Errors that make the whole file unusable come as `error`. */
export function parseClientsCsv(text: string): ParsedClientsCsv | { error: string } {
  if (text.length > CLIENT_IMPORT_MAX_CHARS) return { error: 'El fichero es demasiado grande (máximo 1 MB)' };
  const table = parseCsv(text);
  const [header, ...data] = table;
  if (!header || header.every((h) => !h.trim())) return { error: 'El fichero está vacío' };

  // Column indexes of each field, in the priority order of HEADERS.
  const keys = header.map(headerKey);
  const columns: ParsedClientsCsv['columns'] = {};
  const indexes = {} as Record<Field, number[]>;
  const used = new Set<number>();
  for (const field of Object.keys(HEADERS) as Field[]) {
    indexes[field] = [];
    for (const alias of HEADERS[field]) {
      keys.forEach((key, index) => {
        if (key === alias && !used.has(index)) {
          indexes[field].push(index);
          used.add(index);
        }
      });
    }
    if (indexes[field].length) columns[field] = indexes[field].map((i) => header[i]!.trim());
  }
  if (!indexes.name.length) return { error: 'No encuentro la columna del nombre (por ejemplo, «Nombre»)' };
  const ignoredColumns = header.map((h, i) => (used.has(i) ? '' : h.trim())).filter(Boolean);

  const rows: ImportedClientRow[] = [];
  const skipped: SkippedClientRow[] = [];
  const phones = new Map<string, number>();
  let total = 0;
  data.forEach((cells, offset) => {
    const row = offset + 2;
    if (cells.every((c) => !c.trim())) return;
    total += 1;
    const pick = (field: Field) => indexes[field].map((i) => tidy(cells[i])).filter(Boolean);
    const name = [...pick('name'), ...pick('surname')].join(' ').slice(0, 200);
    const skip = (reason: string) => skipped.push({ row, name: name || null, reason });
    if (name.length < 2) return skip('Falta el nombre');
    if (name.length > 80) return skip('El nombre es demasiado largo (máximo 80 caracteres)');

    const rawPhone = pick('phone')[0] ?? '';
    const phone = rawPhone ? normalizePhone(rawPhone) : null;
    if (rawPhone && !phone) return skip(`Teléfono no válido: ${rawPhone}`);
    const rawEmail = pick('email')[0] ?? '';
    if (rawEmail && !isValidEmail(rawEmail)) return skip(`Email no válido: ${rawEmail}`);
    const notes = pick('notes').join(' · ');
    if (notes.length > 2000) return skip('Las notas son demasiado largas (máximo 2000 caracteres)');
    if (phone) {
      const first = phones.get(phone);
      if (first) return skip(`Teléfono repetido en el fichero (ya está en la fila ${first})`);
      phones.set(phone, row);
    }
    rows.push({ row, name, phone, email: rawEmail ? rawEmail.toLowerCase() : null, notes: notes || null });
  });
  if (total > CLIENT_IMPORT_MAX_ROWS) {
    return { error: `El fichero tiene ${total} clientes; el máximo por importación es ${CLIENT_IMPORT_MAX_ROWS}` };
  }
  return { total, rows, skipped, columns, ignoredColumns };
}
