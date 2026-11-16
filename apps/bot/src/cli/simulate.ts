/**
 * WhatsApp simulator: injects messages as if they came from Meta's webhook and
 * prints the bot replies. Interactive buttons/list rows are numbered: type `#1` to press one.
 *
 *   pnpm bot:simulate --tenant fisiodemo --phone +34600000000 [--llm mock|live]
 *
 * Works with piped input too (one message per line), which is how the transcript in
 * docs/PROGRESS.md is produced. Messages go through the same durable inbound queue as the real
 * webhook (stored, then processed by an in-process worker). Do not run it at the same time as
 * `pnpm dev:bot` on the same database: the bot's worker could take the simulator's messages.
 */
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { createDatabaseClients, createRepos, type Tenant } from '@clinicai/db';
import {
  APPOINTMENT_STATUS_LABELS_ES,
  formatHumanDateTime,
  normalizePhone,
  normalizeText,
  type AppointmentStatusValue,
} from '@clinicai/shared';
import { loadConfig } from '../config';
import { createDeps } from '../deps';
import { createConversationEngine } from '../engine/engine';
import { checkAndSendReminders } from '../jobs/reminders';
import { processWaitlist } from '../jobs/waitlist';
import type { OutgoingMessage } from '../engine/types';
import { createSilentLogger } from '../logger';
import { createInboundEventHandler } from '../queue/handler';
import { ingestWhatsAppPayload } from '../queue/ingest';
import { createInboundWorker } from '../queue/worker';
import { chatwootObserver } from '../services/chatwoot';
import { createMockTranscriber } from '../services/transcription';
import { createMockWhatsAppClient, mockMediaId } from '../services/whatsapp';
import { OffsetClock } from '../utils/clock';
import { metaWebhookSchema } from '../webhook/meta';

interface Pressable {
  kind: 'button' | 'list' | 'template';
  id: string;
  title: string;
}

const { values: args } = parseArgs({
  options: {
    tenant: { type: 'string', default: 'fisiodemo' },
    phone: { type: 'string', default: '+34600000000' },
    llm: { type: 'string', default: 'mock' },
    name: { type: 'string', default: 'Cliente Simulador' },
  },
});

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

function indent(textValue: string): string {
  return textValue
    .split('\n')
    .map((l, i) => (i === 0 ? l : `   ${l}`))
    .join('\n');
}

async function resolveTenant(repos: ReturnType<typeof createRepos>, key: string): Promise<Tenant | null> {
  const byId = /^[0-9a-f-]{36}$/i.test(key) ? await repos.tenants.findById(key) : null;
  if (byId) return byId;
  const byNumber = await repos.tenants.findByWaPhoneNumberId(key);
  if (byNumber) return byNumber;
  const slug = normalizeText(key).replace(/[^a-z0-9]/g, '');
  const all = await repos.tenants.listAll();
  return all.find((t) => normalizeText(t.clinicName).replace(/[^a-z0-9]/g, '') === slug) ?? null;
}

async function main(): Promise<void> {
  const phone = normalizePhone(args.phone ?? '');
  if (!phone) throw new Error(`Teléfono inválido: ${args.phone}`);
  const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5433/clinicai';
  const llmMode = args.llm === 'live' ? 'live' : 'mock';

  const config = loadConfig({
    ...process.env,
    DATABASE_URL: databaseUrl,
    WHATSAPP_MODE: 'mock',
    LLM_MODE: llmMode,
    ENABLE_CRON: 'false',
  });
  const logger = createSilentLogger();
  // The simulator's own commands (/citas, /estado…) are diagnostics: owner connection (F19).
  const clients = createDatabaseClients(databaseUrl, process.env.DATABASE_APP_URL || null);
  const repos = createRepos(clients.system);
  const whatsapp = createMockWhatsAppClient();
  const clock = new OffsetClock();
  // The simulated voice notes carry their text: they are never sent to OpenAI.
  const transcriber = config.VOICE_NOTES ? createMockTranscriber() : null;
  const deps = createDeps(config, logger, { db: clients.app, systemDb: clients.system, systemRepos: repos, whatsapp, clock, transcriber });
  const observer = chatwootObserver(deps.chatwoot);
  const engine = createConversationEngine(deps, observer);
  const worker = createInboundWorker(deps, createInboundEventHandler(deps, engine, deps.chatwoot));

  const tenant = await resolveTenant(repos, args.tenant ?? '');
  if (!tenant) throw new Error(`No existe el tenant "${args.tenant}". ¿Has ejecutado pnpm db:seed?`);
  if (!tenant.waPhoneNumberId) throw new Error('El tenant no tiene wa_phone_number_id configurado');

  out(`📱 Simulador de WhatsApp · ${tenant.clinicName} · cliente ${phone} · LLM ${llmMode}`);
  out('   Escribe mensajes como el cliente. #N pulsa un botón · /ayuda para ver comandos.\n');

  let printed = 0;
  let pressables: Pressable[] = [];
  let counter = 0;

  const printMessage = (message: OutgoingMessage): void => {
    switch (message.type) {
      case 'text':
        out(`🤖 ${indent(message.text)}`);
        break;
      case 'buttons': {
        out(`🤖 ${indent(message.body)}`);
        const base = pressables.length;
        const added = message.buttons.map((b) => ({ kind: 'button' as const, id: b.id, title: b.title }));
        pressables = [...pressables, ...added];
        out(`   ${added.map((p, i) => `[#${base + i + 1} ${p.title}]`).join('  ')}`);
        break;
      }
      case 'list': {
        out(`🤖 ${indent(message.body)}`);
        out(`   ☰ ${message.buttonText}:`);
        const base = pressables.length;
        const rows = message.sections.flatMap((s) => s.rows);
        pressables = [...pressables, ...rows.map((r) => ({ kind: 'list' as const, id: r.id, title: r.title }))];
        rows.forEach((r, i) => out(`     #${base + i + 1} ${r.title}${r.description ? ` — ${r.description}` : ''}`));
        break;
      }
      case 'template': {
        out(`🤖 [plantilla ${message.name}] ${indent(message.preview)}`);
        const base = pressables.length;
        const added = message.previewButtons.map((title, i) => ({
          kind: 'template' as const,
          id: message.quickReplyPayloads[i] ?? '',
          title,
        }));
        pressables = [...pressables, ...added];
        out(`   ${added.map((p, i) => `[#${base + i + 1} ${p.title}]`).join('  ')}`);
        break;
      }
    }
  };

  const flush = (): void => {
    const batch = whatsapp.outbox.slice(printed).filter((entry) => entry.to === phone);
    // A turn with new buttons replaces the previous ones; otherwise they stay pressable.
    if (batch.some((entry) => entry.message.type !== 'text')) pressables = [];
    for (const entry of batch) printMessage(entry.message);
    printed = whatsapp.outbox.length;
  };

  const inject = async (message: Record<string, unknown>): Promise<void> => {
    counter += 1;
    const payload = metaWebhookSchema.parse({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'simulator',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: 'simulator', phone_number_id: tenant.waPhoneNumberId },
                contacts: [{ wa_id: phone.replace('+', ''), profile: { name: args.name } }],
                messages: [
                  {
                    from: phone.replace('+', ''),
                    id: `wamid.sim.${Date.now()}.${counter}`,
                    timestamp: String(Math.floor(clock.now().getTime() / 1000)),
                    ...message,
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const ingested = await ingestWhatsAppPayload(deps, payload);
    if (ingested.rateLimited > 0) out('   ⚠️ Mensaje descartado por el límite de mensajes por minuto (RATE_LIMIT_PER_MINUTE).');
    await worker.drain();
    await deps.background.idle();
    flush();
  };

  const commands: Record<string, (arg: string) => Promise<void>> = {
    '/ayuda': async () => {
      out('   #N                 pulsar el botón o fila N del último mensaje interactivo');
      out('   /estado            ver el estado de la conversación');
      out('   /citas             ver las citas del cliente');
      out('   /avanzar <n>d|h    adelantar el reloj simulado (p. ej. /avanzar 1d)');
      out('   /hora              ver la hora simulada');
      out('   /recordatorios     ejecutar ahora el job de recordatorios (citas de mañana)');
      out('   /lista-espera      ofrecer ahora los huecos libres a la lista de espera');
      out('   /reset             borrar el estado de la conversación');
      out('   /audio <texto>     enviar una nota de voz que dice <texto>');
      out('   /foto              enviar una imagen (no textual)');
      out('   /salir             terminar');
    },
    '/estado': async () => {
      const state = await repos.conversations.get(tenant.id, phone, clock.now());
      out(`   ⚙ estado: ${state ? `${state.flow}/${state.step} · errores ${state.errorCount}` : 'sin conversación activa'}`);
    },
    '/citas': async () => {
      const client = await repos.clients.findByPhone(tenant.id, phone);
      if (!client) {
        out('   ⚙ el cliente no está registrado');
        return;
      }
      const detail = await repos.clients.getWithAppointments(tenant.id, client.id);
      for (const a of detail?.appointments ?? []) {
        out(
          `   ⚙ ${formatHumanDateTime(a.date, tenant.timezone)} · ${a.employee.name} · ${
            APPOINTMENT_STATUS_LABELS_ES[a.status as AppointmentStatusValue]
          } (${a.status}) · ${a.source}`,
        );
      }
      if (!detail?.appointments.length) out('   ⚙ sin citas');
    },
    '/avanzar': async (arg) => {
      const m = /^(\d+)\s*([dh])$/.exec(arg.trim());
      if (!m) {
        out('   ⚙ uso: /avanzar 1d  o  /avanzar 3h');
        return;
      }
      clock.offsetMs += Number(m[1]) * (m[2] === 'd' ? 86_400_000 : 3_600_000);
      out(`   ⚙ hora simulada: ${formatHumanDateTime(clock.now(), tenant.timezone)}`);
    },
    '/hora': async () => out(`   ⚙ hora simulada: ${formatHumanDateTime(clock.now(), tenant.timezone)}`),
    '/reset': async () => {
      await repos.conversations.clear(tenant.id, phone);
      out('   ⚙ estado borrado');
    },
    '/recordatorios': async () => {
      const result = await checkAndSendReminders(deps, { force: true, tenantId: tenant.id }, observer);
      // F30: also the optional second reminder of the same day.
      out(`   ⚙ recordatorios enviados: ${result.sent} · segundos avisos: ${result.second} · fallidos: ${result.failed}`);
      flush();
    },
    '/lista-espera': async () => {
      const result = await processWaitlist(deps, { tenantId: tenant.id }, observer);
      out(`   ⚙ lista de espera: ofertas enviadas ${result.offered} · fallidas ${result.failed}`);
      flush();
    },
    '/audio': async (arg) =>
      inject({ type: 'audio', audio: { id: mockMediaId(arg.trim()), mime_type: 'audio/ogg; codecs=opus', voice: true } }),
    '/foto': async () => inject({ type: 'image', image: { id: 'mock-image', mime_type: 'image/jpeg' } }),
  };

  const rl = readline.createInterface({ input: process.stdin, terminal: process.stdin.isTTY });
  const interactive = Boolean(process.stdin.isTTY);
  if (interactive) process.stdout.write('👤 > ');
  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!interactive && line) out(`👤 ${line}`);
    if (line === '/salir' || line === '/exit') break;
    if (line) {
      const [cmd = '', ...rest] = line.split(' ');
      const pressed = /^#(\d+)$/.exec(line);
      if (pressed) {
        const option = pressables[Number(pressed[1]) - 1];
        if (!option) out('   ⚙ no hay ningún botón con ese número');
        else if (option.kind === 'template') {
          await inject({ type: 'button', button: { payload: option.id, text: option.title } });
        } else if (option.kind === 'button') {
          await inject({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: option.id, title: option.title } } });
        } else {
          await inject({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: option.id, title: option.title } } });
        }
      } else if (commands[cmd]) {
        await commands[cmd](rest.join(' '));
      } else {
        await inject({ type: 'text', text: { body: line } });
      }
    }
    if (interactive) process.stdout.write('👤 > ');
  }
  rl.close();
  await Promise.all([clients.system.$disconnect(), clients.app.$disconnect()]);
}

main().catch((error: unknown) => {
  console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
