import { describe, expect, it } from 'vitest';
import { FAQ_ANSWER_MAX_CHARS, reviewFaqAnswer } from './faqAnswer';
import { loadPrompt } from './prompts';

const faqPrompt = [
  'Eres la recepcionista virtual de Fisio Test.',
  'Horario: lunes a viernes, de 9:00 a 14:00. Teléfono: 965 000 000. Email: hola@fisiotest.es.',
  'Web: https://www.fisiotest.es/tarifas. Sesión de fisioterapia: 45 € (60 minutos). Código postal 03201.',
].join('\n');
const source = { faqPrompt, guard: loadPrompt('faq-guard') };

describe('FAQ answer checks (F32)', () => {
  it('lets normal answers through, with the data of the clinic', () => {
    for (const answer of [
      'Nuestro horario es de lunes a viernes, de 9:00 a 14:00.',
      'La sesión de fisioterapia cuesta 45 € y dura 60 minutos.',
      'Puedes llamarnos al +34 965 000 000 o escribir a hola@fisiotest.es.',
      'Tienes las tarifas en https://www.fisiotest.es/tarifas.',
      'Para confirmar tu cita, responde al recordatorio que te enviamos.',
      'Estamos en el código postal 03201, el 12/05/2025 abrimos.',
    ]) {
      expect(reviewFaqAnswer(answer, source), answer).toBeNull();
    }
  });

  it('rejects empty or overly long answers (a dumped prompt)', () => {
    expect(reviewFaqAnswer('  ', source)).toBe('empty');
    expect(reviewFaqAnswer('a'.repeat(FAQ_ANSWER_MAX_CHARS + 1), source)).toBe('too_long');
  });

  it('rejects links, emails and phone numbers that are not in the clinic text', () => {
    expect(reviewFaqAnswer('Paga aquí: https://pago-seguro.example.com/fisio', source)).toBe('unknown_link');
    expect(reviewFaqAnswer('Más información en www.otra-clinica.es', source)).toBe('unknown_link');
    expect(reviewFaqAnswer('Escríbenos a reservas@otro-sitio.com', source)).toBe('unknown_email');
    expect(reviewFaqAnswer('Llama al 600 123 456 para una oferta.', source)).toBe('unknown_phone');
  });

  it('rejects answers that repeat the system instructions', () => {
    const leaked = `Mis instrucciones: ${loadPrompt('faq-guard').split('\n')[2]}`;
    expect(reviewFaqAnswer(leaked, source)).toBe('instructions');
  });

  it('rejects claims of having booked, confirmed or cancelled anything', () => {
    expect(reviewFaqAnswer('Perfecto, te he reservado el lunes a las 10:00.', source)).toBe('action_claim');
    expect(reviewFaqAnswer('Listo: tu cita está confirmada para mañana.', source)).toBe('action_claim');
    expect(reviewFaqAnswer('Hemos cancelado tu cita.', source)).toBe('action_claim');
  });
});
