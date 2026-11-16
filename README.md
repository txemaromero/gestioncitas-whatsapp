# gestioncitas-whatsapp

Los pacientes reservan cita por **WhatsApp** con un asistente de IA, y la clínica la gestiona desde un **panel web**.

Es un SaaS **multi-tenant** para pequeñas clínicas; el primer caso son las de fisioterapia.

Progreso y decisiones: [`docs/PROGRESS.md`](docs/PROGRESS.md) · Trazabilidad: [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md) · Protección de datos (RGPD): [`docs/rgpd.md`](docs/rgpd.md).

> **Principio de diseño:** el LLM solo **clasifica la intención** (`CITA`/`FAQ`), **interpreta fechas** y **responde preguntas frecuentes**. Todo el flujo de reserva es código determinista, con validación, disponibilidad y una transacción que impide reservar dos veces el mismo hueco.

## Demo

![Recorrido guiado: alta de la clínica, reservas por WhatsApp, recordatorios, lista de espera, página de reservas, calendario, métricas y consola de la plataforma](demo.webp)

Recorrido de unos 7 minutos con una clínica de fisioterapia de ejemplo:
- **Puesta en marcha:** alta de la clínica, ajustes, información para el asistente, servicios, equipo, profesionales con sus horarios y ausencias, y clientes con bonos.
- **El paciente, por WhatsApp:** aviso de privacidad, registro, pregunta frecuente, reserva, recordatorios, lista de espera, cambio de cita y nota de voz.
- **La página pública de reservas:** se elige el hueco y la cita llega escrita a WhatsApp.
- **Después, en el panel:** calendario, agenda en el móvil, asistencia y bonos, métricas, registro de actividad y consola de la plataforma.

WhatsApp y la IA están simulados (`pnpm bot:simulate`). La animación no tiene sonido; lleva subtítulos.

## Funcionalidades

**WhatsApp (bot)**
- Registro conversacional de clientes nuevos (nombre y email), con aviso de asistente virtual (AI Act) y aviso de privacidad que el cliente debe aceptar (RGPD).
- Detección de intención con IA; respuestas FAQ con la información de cada clínica, revisadas antes de enviarse (sin enlaces ni teléfonos ajenos al texto de la clínica, sin decir que ha reservado nada).
- Reserva guiada: fecha en lenguaje natural («pasado mañana a las 12»), hasta 6 meses vista, profesionales disponibles con botones o lista, confirmación y hasta 3 huecos alternativos si no hay disponibilidad.
- Servicios con duración propia (por ejemplo, punción seca de 30 min): si la clínica tiene varios, el bot pregunta cuál antes de la fecha. Las ausencias de cada profesional y los festivos de la clínica bloquean la reserva.
- Gestión de citas existentes: «Mis citas» en el saludo, o frases como «quiero cancelar mi cita» o «cambiar la cita». El cliente puede ver sus próximas citas, cancelarlas o cambiarlas de fecha, con una antelación mínima configurable por clínica (24 h por defecto).
- Reservas desde la página web de la clínica: el mensaje que llega de la página lleva el hueco elegido y el bot va directo a él (también tras registrar al cliente).
- Bonos: «¿cuántas sesiones me quedan?» responde con lo que le queda de cada bono y hasta cuándo vale.
- Recordatorios con plantilla de Meta y botones «Sí, confirmo» / «No puedo asistir»: 1 o 2 días antes y, si la clínica quiere, otro unas horas antes el mismo día (nunca de noche).
- Lista de espera (activable por clínica): si no hay hueco, el cliente pulsa «🔔 Avisarme». Cuando alguien cancela, el primero de la lista recibe un aviso con el botón «Reservar»; si no responde en 30 minutos, el hueco pasa al siguiente.
- Atención humana con Chatwoot: historial completo, respuesta del agente por WhatsApp y `/bot off|on|status`.
- Notas de voz: el bot las transcribe (OpenAI, sin guardar el audio), repite lo que ha entendido y sigue la conversación como si fueran texto. Hasta 2 minutos, y solo después de aceptar el aviso de privacidad.
- Palabras de escape (`cancelar`, `salir`, `menú`). Tras 3 fallos de comprensión, sugiere llamar a la clínica.

**Panel web**
- Acceso sin contraseña (email + código, Kinde) y alta de clínica (*onboarding*).
- Equipo (Ajustes): se invita por email a administradores y a profesionales (la invitación caduca a los 14 días) y se puede cambiar el rol de cada uno. Cada profesional entra y solo ve y gestiona sus propias citas. Cualquiera menos el propietario puede «Salir de la clínica».
- Calendario (mes, semana, día) con colores por profesional, panel de próximas citas y modal de cita que aplica la misma regla de disponibilidad que el bot. Las citas canceladas no aparecen, ni en el calendario ni en las próximas citas, salvo con «Ver canceladas».
- Gestión de empleados (con horario semanal y ausencias) y de clientes (con su historial de citas), con importación desde CSV (Excel u otro programa).
- Ajustes: nombre, teléfono de contacto, duración de cita, servicios, festivos y cierres, información para el asistente (dirección, horario, pagos, servicios y precios… en un formulario; o un `.txt` propio), credenciales de WhatsApp (el número se comprueba con Meta; token cifrado) y protección de datos.
- El calendario muestra las ausencias (rayadas, con el color del profesional) y los cierres (sombreados).
- Asistencia: tras cada cita se marca si el cliente vino o no (desde Inicio, el calendario o la ficha de la cita).
- Tratamientos: varias sesiones de una vez («Repetir» en «Nueva Cita»), con vista previa de las fechas y las que se saltan, y «Cancelar esta y las siguientes».
- Bonos de sesiones en la ficha del cliente: se descuenta una al marcar «Asistió» (y «No vino», si la clínica quiere).
- Agenda en el móvil: cada profesional se suscribe a la suya desde Google Calendar, Apple Calendar u Outlook (enlace secreto de solo lectura, con las iniciales de los clientes).
- Página de reservas pública (`/reservar/<clínica>`), que se publica en Ajustes: servicios y huecos libres de 14 días; al elegir una hora se abre WhatsApp con la cita escrita. Con código QR para el mostrador y botón para la web de la clínica.
- Lista de espera en Inicio: quién espera, para qué día y si ya tiene un aviso abierto. Se puede añadir a alguien (p. ej. si llama por teléfono) o quitarlo. Al cancelar o mover una cita en el panel, el bot ofrece el hueco en un segundo.
- Registro de actividad (propietario y administradores): quién hizo qué y cuándo, en el panel y por WhatsApp, sin datos personales y durante 2 años.
- Consola de la plataforma (solo para quien gestiona el servicio): clínicas, actividad, mensajes, consumo de IA y coste estimado de cada mes, sin datos de los clientes.
- Métricas por mes: tasa de no presentados y su evolución en 6 meses, citas sin marcar, cancelaciones, reservas por WhatsApp, ocupación de cada profesional (descontando ausencias y cierres) y citas por servicio.

## Arquitectura

```
Cliente (WhatsApp) ─► Meta Cloud API ─► apps/bot (Fastify, Railway :3008)
                                          ├─ /webhook (firma X-Hub-Signature-256, idempotencia)
                                          ├─ cola duradera inbound_events → workers (orden por conversación)
                                          ├─ motor de flujos (estado en BD)
                                          ├─ services/aiServices.ts ─► OpenAI │ DeepSeek (fallback)
                                          ├─ cron recordatorios cada 15 min (hora de cada clínica)
                                          └─ /chatwoot/webhook ◄─► Chatwoot
                                                    │
                          PostgreSQL (Supabase) ◄── packages/db (Prisma 7)
                                                    ▲
Administrador ─► apps/web (Next.js 16, Netlify) ── tRPC 11 ── Kinde
```

| Carpeta | Contenido |
|---|---|
| `packages/shared` | Lógica de dominio isomórfica: zonas horarias (con cambio de hora), horarios, **disponibilidad**, ajustes del tenant (zod), teléfonos E.164, cifrado AES-256-GCM, plantilla FAQ por defecto |
| `packages/db` | Esquema Prisma, migraciones (incluida RLS), repositorios con `tenantId` obligatorio, reserva transaccional, seed y utilidades de test |
| `apps/bot` | Servidor de WhatsApp: webhook, motor y flujos (`src/flows`), LLM (`src/services/aiServices.ts`, `src/prompts/*.txt`), recordatorios, Chatwoot, simulador |
| `apps/web` | Panel de administración (App Router, tRPC, shadcn/ui-style, FullCalendar 7) |
| `eval/` | Evaluación del prompt de intención y de las FAQ con Ragas (Python) |

**Multi-tenant:** una BD y un código para N clínicas. El bot identifica la clínica por el `phone_number_id` de Meta; la web, por la sesión de Kinde (`tenant_members`). Ningún dato de tenant viene del cliente. Además, las claves foráneas compuestas impiden en la propia BD enlazar citas con clientes o empleados de otra clínica. La app y el bot trabajan con el rol `clinicai_app`, con RLS por clínica: PostgreSQL solo les deja ver y cambiar las filas de la clínica de cada petición (F19).

## Puesta en marcha en local

Requisitos: **Node 24** (≥ 22.12), **pnpm 12** (`npm i -g pnpm@12.18.0`). No hace falta Docker: hay un PostgreSQL embebido.

```bash
pnpm install                          # instala y genera el cliente Prisma
cp packages/db/.env.example packages/db/.env
cp apps/bot/.env.example apps/bot/.env          # WHATSAPP_MODE=mock y LLM_MODE=mock por defecto
cp apps/web/.env.example apps/web/.env.local    # rellena Kinde y ENCRYPTION_KEY

pnpm db:local        # terminal aparte: PostgreSQL en :5433 (o: docker compose up -d → :5432)
pnpm db:migrate      # aplica las migraciones
pnpm db:seed         # FisioDemo (Alicante) + «Clínica Demo Norte»
pnpm db:app-role     # opcional: activa el rol con RLS y muestra DATABASE_APP_URL para los .env
```

Genera una `ENCRYPTION_KEY` (la misma para bot y web):
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`

### Probar el bot sin Meta: el simulador

```bash
pnpm bot:simulate --tenant fisiodemo --phone +34600000000
```

Escribe como si fueras el paciente. `#1`, `#2`… pulsan los botones del último mensaje. Comandos: `/estado`, `/citas`, `/avanzar 1d`, `/recordatorios`, `/audio <texto>` (nota de voz simulada que «dice» ese texto), `/foto`, `/lista-espera` (ofrece ya los huecos libres), `/reset`, `/salir`. Con `--llm live` usa el proveedor real (necesita `OPENAI_API_KEY`). También acepta la entrada redirigida, con un mensaje por línea.

### Panel web

```bash
pnpm dev:web                # http://localhost:3000 (necesita Kinde configurado)
pnpm dev                    # bot + web a la vez
```

Para entrar como administrador de FisioDemo: inicia sesión una vez, copia tu id de Kinde (`kp_…`) y ejecuta `SEED_KINDE_USER_ID=kp_… pnpm db:seed`. Si no lo haces, el primer acceso te llevará al alta de una clínica nueva.

### Con WhatsApp real (ngrok)

Pon `WHATSAPP_MODE=live` y las credenciales de Meta en `apps/bot/.env`, ejecuta `pnpm dev:bot` y `ngrok http 3008`, y registra `https://<id>.ngrok-free.app/webhook` en Meta for Developers. Los pasos completos están en [`docs/deploy.md`](docs/deploy.md#probar-en-local-con-ngrok).

## Calidad

| Comando | Qué hace |
|---|---|
| `pnpm lint` | ESLint 9 (raíz + reglas de Next en `apps/web`) |
| `pnpm typecheck` | `tsc` estricto en todos los paquetes |
| `pnpm test` | Vitest: lógica compartida, BD, LLM (con mocks), webhook, conversaciones CU-C1…C9, recordatorios, Chatwoot, routers tRPC con aislamiento entre tenants y contraste del borde de los campos del panel (≥ 3:1, WCAG 1.4.11). Los tests de BD levantan un PostgreSQL efímero (o usan `TEST_DATABASE_URL`) |
| `pnpm build:web` | `next build` |
| `pnpm preflight` | Comprobación previa al despliegue, sin escribir ni enviar nada: base de datos, Meta, OpenAI, Kinde, Chatwoot y servicios desplegados (`--web-env`, `--bot-url`, `--web-url`) |
| `pnpm e2e` | Playwright, con autenticación simulada: crear, editar y borrar citas, empleados y clientes; bonos y tratamientos; página de reservas, enlace de agenda, información del asistente y consola de la plataforma; política de seguridad (CSP) sin infracciones y accesibilidad (axe, WCAG 2.1 AA) de cada página (requiere `pnpm build:web` y `pnpm db:local`) |
| `LLM_LIVE_TESTS=true pnpm test` | Añade las 29 expresiones de fecha contra el LLM real |
| `python eval/eval_intent.py` · `python eval/eval_faq.py` | Evaluación con Ragas (ver [`eval/README.md`](eval/README.md)) |

La CI de GitHub Actions ejecuta lint, typecheck, test (con PostgreSQL 17 como servicio), la *build* web y el e2e, y construye la imagen del bot. El workflow «Dependencias» busca vulnerabilidades conocidas cuando cambian las dependencias y cada lunes, y «Evaluación IA» evalúa los prompts cuando cambian.

## Variables de entorno

Cada app tiene su `.env.example` comentado: [`apps/bot/.env.example`](apps/bot/.env.example), [`apps/web/.env.example`](apps/web/.env.example) y [`packages/db/.env.example`](packages/db/.env.example). Las más importantes:

- **Bot**: `DATABASE_URL`, `DATABASE_APP_URL`, `WHATSAPP_MODE` (`live`/`mock`), `META_*`, `VERIFY_TOKEN`, `LLM_MODE` (`live`/`mock`), `AI_PROVIDER`, `ENABLE_FALLBACK`, `FALLBACK_PROVIDER`, `OPENAI_*` (incluidos `OPENAI_FALLBACK_MODEL` y `OPENAI_TRANSCRIBE_MODEL`), `DEEPSEEK_*`, `VOICE_NOTES`, `VOICE_MAX_SECONDS`, `WA_REMINDER_TEMPLATE`, `WA_WAITLIST_TEMPLATE`, `WAITLIST_CRON`, `WAITLIST_OFFER_MINUTES`, `REMINDER_CRON`, `CRON_SECRET`, `ENCRYPTION_KEY` y `CHATWOOT_*`.
- **Web**: `DATABASE_URL`, `DATABASE_APP_URL`, `KINDE_*`, `ENCRYPTION_KEY`, `PLATFORM_ADMIN_EMAILS` (consola de la plataforma), `PLATFORM_PRICES` (opcional), `WHATSAPP_MODE` (`mock` solo en local), `NEXT_PUBLIC_CHATWOOT_URL` y, solo en caso de problemas, `CSP_REPORT_ONLY`.
- En producción, bot y panel no arrancan sin `DATABASE_APP_URL`.

## Despliegue

Bot en **Railway** (`apps/bot/Dockerfile`, configurado en el servicio), web en **Netlify** (`netlify.toml`) y BD en **Supabase**. Guía paso a paso, con Meta, Kinde y Chatwoot: [`docs/deploy.md`](docs/deploy.md). Plantillas del recordatorio y de la lista de espera: [`docs/meta-template.md`](docs/meta-template.md).

## Costes (MVP)

Capas gratuitas de Railway, Netlify, Supabase y Kinde. El coste dominante a escala son las plantillas de Meta (≈ 0,017 € cada una en España desde octubre de 2026; las respuestas dentro de la ventana de 24 h son gratis hasta 1.000 al mes por número): por eso hay **como máximo dos recordatorios por cita** (el segundo, opcional), y la lista de espera avisa de un hueco a una sola persona cada vez. La consola de la plataforma estima el coste de cada clínica. La IA consume ≈ 1.050 tokens por cita; los prompts son compactos y no se envía historial al LLM. Transcribir notas de voz con `gpt-transcribe` cuesta 0,0045 $ por minuto de audio.
