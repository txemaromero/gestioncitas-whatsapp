import { describe, expect, it } from 'vitest';
import { buildDefaultFaqPrompt, FAQ_ALWAYS_IMPORTANT, suggestedServiceLines, UNKNOWN_INFO } from './faq-template';
import { assistantInfoSchema, FAQ_PROMPT_MAX_BYTES } from './settings';

const employees = [{ name: 'Ana', role: 'fisioterapeuta', active: true, schedule: [{ day: 'monday' as const, start: '09:00', end: '14:00' }] }];
const services = [
  { name: 'Sesión de fisioterapia', durationMinutes: 60, active: true },
  { name: 'Punción seca', durationMinutes: 30, active: true },
  { name: 'Antiguo', durationMinutes: 45, active: false },
];

describe('assistant information (F29)', () => {
  it('fills the template with what the clinic wrote in Settings', () => {
    const info = assistantInfoSchema.parse({
      address: ' C/ Luna, 5 ',
      city: 'Elche',
      payments: 'Efectivo y Bizum',
      services: ['Sesión de fisioterapia (1 h): 40 €'],
      notes: ['Trae ropa cómoda.'],
    });
    const prompt = buildDefaultFaqPrompt({ clinicName: 'Fisio Luna', phone: '965 111 222', sector: 'clínica de fisioterapia', employees, info, services });
    expect(prompt.split('\n')[0]).toBe(
      'Actúas como recepcionista virtual de Fisio Luna, una clínica de fisioterapia ubicada en Elche. Tu tarea es responder preguntas frecuentes de forma clara, profesional y concisa.',
    );
    expect(prompt).toContain('Dirección: C/ Luna, 5\nTeléfono: 965 111 222\nHorario: lunes de 09:00 a 14:00\nPagos: Efectivo y Bizum');
    expect(prompt).toContain(`Aseguradoras: ${UNKNOWN_INFO}\nParking: ${UNKNOWN_INFO}`);
    expect(prompt).toContain('Servicios y tratamientos:\n- Sesión de fisioterapia (1 h): 40 €\n\nProfesionales:\n- Ana: fisioterapeuta');
    expect(prompt).toContain(`Información importante:\n- Trae ropa cómoda.\n- ${FAQ_ALWAYS_IMPORTANT}\n`);
    // Masculine sectors.
    expect(buildDefaultFaqPrompt({ clinicName: 'X', sector: 'centro de estética', employees, info })).toContain('un centro de estética ubicado en Elche.');
  });

  it('without information: the panel services and «Consultar por teléfono»', () => {
    const prompt = buildDefaultFaqPrompt({ clinicName: 'Fisio Luna', phone: '965 111 222', employees, services });
    expect(prompt).toContain('una clínica de fisioterapia. Tu tarea');
    expect(prompt).toContain(`Dirección: ${UNKNOWN_INFO}`);
    expect(prompt).toContain('Servicios y tratamientos:\n- Sesión de fisioterapia (1 h)\n- Punción seca (30 min)\n\n');
    expect(prompt).toContain(`Información importante:\n- ${FAQ_ALWAYS_IMPORTANT}\n`);
    expect(buildDefaultFaqPrompt({ clinicName: 'Y', employees: [] })).toContain(`Servicios y tratamientos:\n- ${UNKNOWN_INFO}`);
    expect(suggestedServiceLines(services)).toEqual(['Sesión de fisioterapia (1 h)', 'Punción seca (30 min)']);
  });

  it('has limits that keep the prompt under 20 KB', () => {
    const big = assistantInfoSchema.parse({
      address: 'a'.repeat(200),
      city: 'b'.repeat(80),
      hours: 'c'.repeat(300),
      payments: 'd'.repeat(300),
      insurers: 'e'.repeat(500),
      parking: 'f'.repeat(300),
      services: Array.from({ length: 40 }, () => 'g'.repeat(200)),
      notes: Array.from({ length: 20 }, () => 'h'.repeat(300)),
    });
    const prompt = buildDefaultFaqPrompt({ clinicName: 'Z'.repeat(80), phone: '9'.repeat(30), employees, info: big });
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(FAQ_PROMPT_MAX_BYTES);
    expect(assistantInfoSchema.safeParse({ services: Array.from({ length: 41 }, () => 'x') }).success).toBe(false);
    expect(assistantInfoSchema.safeParse({ address: 'x'.repeat(201) }).success).toBe(false);
  });
});
