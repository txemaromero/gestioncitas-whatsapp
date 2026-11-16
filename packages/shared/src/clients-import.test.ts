import { describe, expect, it } from 'vitest';
import { CLIENT_IMPORT_MAX_ROWS, decodeCsvBytes, detectDelimiter, parseClientsCsv, parseCsv } from './clients-import';

describe('CSV reading', () => {
  it('detects the delimiter of Excel in Spain (;), commas and tabs', () => {
    expect(detectDelimiter('Nombre;Teléfono;Email\nAna;600;')).toBe(';');
    expect(detectDelimiter('name,phone\nAna,600')).toBe(',');
    expect(detectDelimiter('nombre\ttelefono')).toBe('\t');
    // Delimiters inside quotes do not count.
    expect(detectDelimiter('"Nombre; completo",Teléfono')).toBe(',');
  });

  it('handles BOM, quotes, escaped quotes, line breaks inside quotes and CRLF', () => {
    const text = String.fromCharCode(0xfeff) + 'Nombre;Notas\r\n"Ruiz; Ana";"Dice ""hola""\nsegunda línea"\r\nLuis;\r\n';
    expect(parseCsv(text)).toEqual([
      ['Nombre', 'Notas'],
      ['Ruiz; Ana', 'Dice "hola"\nsegunda línea'],
      ['Luis', ''],
    ]);
  });

  it('decodes UTF-8, and Windows-1252 when the bytes are not valid UTF-8', () => {
    expect(decodeCsvBytes(new TextEncoder().encode('Muñoz;José'))).toBe('Muñoz;José');
    // "Muñoz" as saved by Excel in Spain (ñ = 0xF1).
    expect(decodeCsvBytes(new Uint8Array([0x4d, 0x75, 0xf1, 0x6f, 0x7a]))).toBe('Muñoz');
  });
});

describe('parseClientsCsv', () => {
  it('recognises the columns by name, joins the surnames and prefers the mobile', () => {
    const csv = [
      'Nombre;Apellidos;Teléfono fijo;Móvil;Correo electrónico;Observaciones;Fecha alta',
      'Ana;García López;965 111 222;600 111 222;Ana@Mail.com;Rodilla;01/02/2024',
      'Luis;;;;;;',
    ].join('\n');
    const result = parseClientsCsv(csv);
    if ('error' in result) throw new Error(result.error);
    expect(result.columns).toEqual({
      name: ['Nombre'],
      surname: ['Apellidos'],
      phone: ['Móvil', 'Teléfono fijo'],
      email: ['Correo electrónico'],
      notes: ['Observaciones'],
    });
    expect(result.ignoredColumns).toEqual(['Fecha alta']);
    expect(result.rows).toEqual([
      { row: 2, name: 'Ana García López', phone: '+34600111222', email: 'ana@mail.com', notes: 'Rodilla' },
      { row: 3, name: 'Luis', phone: null, email: null, notes: null },
    ]);
  });

  it('skips invalid rows with the reason, and repeated phones in the file', () => {
    const csv = [
      'name,phone,email',
      'Ana Ruiz,600111222,',
      ',600222333,',
      'Pepe,12,',
      'Lola,,no-es-un-email',
      'Ana Ruiz bis,+34 600 111 222,',
      ',,',
      `${'x'.repeat(81)},,`,
    ].join('\n');
    const result = parseClientsCsv(csv);
    if ('error' in result) throw new Error(result.error);
    expect(result.total).toBe(6);
    expect(result.rows.map((r) => r.row)).toEqual([2]);
    expect(result.skipped).toEqual([
      { row: 3, name: null, reason: 'Falta el nombre' },
      { row: 4, name: 'Pepe', reason: 'Teléfono no válido: 12' },
      { row: 5, name: 'Lola', reason: 'Email no válido: no-es-un-email' },
      { row: 6, name: 'Ana Ruiz bis', reason: 'Teléfono repetido en el fichero (ya está en la fila 2)' },
      { row: 8, name: 'x'.repeat(81), reason: 'El nombre es demasiado largo (máximo 80 caracteres)' },
    ]);
  });

  it('rejects files that cannot be imported', () => {
    expect(parseClientsCsv('')).toEqual({ error: 'El fichero está vacío' });
    expect(parseClientsCsv('Teléfono;Email\n600111222;')).toEqual({ error: 'No encuentro la columna del nombre (por ejemplo, «Nombre»)' });
    const many = ['Nombre', ...Array.from({ length: CLIENT_IMPORT_MAX_ROWS + 1 }, (_, i) => `Cliente ${i}`)].join('\n');
    expect(parseClientsCsv(many)).toEqual({ error: `El fichero tiene ${CLIENT_IMPORT_MAX_ROWS + 1} clientes; el máximo por importación es ${CLIENT_IMPORT_MAX_ROWS}` });
  });
});
