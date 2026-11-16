# Progreso — gestioncitas-whatsapp

Documento vivo: qué está hecho, decisiones tomadas y pendientes.

## Plan por fases

| Fase | Estado | Notas |
|---|---|---|
| F0 – Base | ✅ | Monorepo pnpm 12, TS 6 estricto, ESLint 9 + Prettier, Vitest 5 (projects), docker-compose, CI |
| F1 – Datos | ✅ | Prisma 7.10 + adapter-pg, migraciones (init + RLS), repos con `tenantId`, disponibilidad y reserva transaccional, seed |
| F2 – LLM | ✅ | `aiServices.ts`: cliente único compatible con OpenAI (OpenAI/DeepSeek), timeout 15 s, 1 reintento, fallback, tokens en log, salidas validadas; mock por reglas; 29 expresiones de fecha con reloj fijo |
| F3 – WhatsApp | ✅ | Webhook GET (challenge en texto plano / 403) y POST (HMAC sobre *raw body*, 200 inmediato y proceso asíncrono), tenant por `phone_number_id`, idempotencia, cliente live (Graph v27.0, reintentos) y mock, `/health`; fixtures reales de Meta |
| F4 – Flujos | ✅ | Motor + router + 8 flujos (`src/flows`), estado en BD (30 min), contador de 3 errores, escape (`cancelar`/`salir`/`menú`), simulador `bot:simulate`; 24 tests de conversación |
| F5 – Recordatorios | ✅ | `jobs/reminders.ts`: node-cron (08:00 Europe/Madrid), `POST /jobs/reminders/run` (`x-cron-secret`), *advisory lock* + `reminder_sent_at`, respuesta por botones o texto (< 24 h); `docs/meta-template.md`; 12 tests |
| F6 – Chatwoot | ✅ | Espejo en cola (entrante/saliente), `POST /chatwoot/webhook` (HMAC `X-Chatwoot-Signature` o `?token=`), mensajes de agente → WhatsApp, `/bot off|on|status` con lista negra persistida, sin bucles; 9 tests con Chatwoot falso |
| F7 – Web | ✅ | Next 16 + Kinde (`proxy.ts`) + tRPC 11 + FullCalendar 7; landing, onboarding, dashboard, calendario, empleados, clientes, ajustes; 12 tests de routers (con aislamiento); `next build` OK; e2e Playwright OK |
| F8 – Evaluación | ✅ | `eval/`: 100 mensajes de intención (50/50), 30 FAQ de FisioDemo, `eval_intent.py` (precisión estricta + matriz de confusión, objetivo ≥ 99 %) y `eval_faq.py` (Ragas `answer_relevancy`/`answer_correctness`, objetivo ≥ 0,75); sin `OPENAI_API_KEY` terminan con salida 0 |
| F9 – Despliegue y docs | ✅ | `apps/bot/Dockerfile` + `railway.json` (migraciones *pre-deploy*, `/health`), `netlify.toml` (plugin Next.js), `docs/deploy.md`, README |
| F10 – Verificación final | ✅ | Lint, typecheck, 191 tests y `next build` sin errores; recorrido completo en el simulador con `pending → confirmed` en BD; casos negativos; cita de WhatsApp visible en el calendario en 13,75 s sin recargar; matriz de trazabilidad completa |
| F11 – Mensajes duraderos | ✅ | Cola `inbound_events` en PostgreSQL: el webhook guarda y luego responde 200 (500 si no puede guardar); *workers* con orden por conversación, *lease* renovado, reintentos con espera creciente, *fencing*, apagado ordenado; límite por teléfono en BD; `/health` con estado de la cola |
| F12 – RGPD | ✅ | Aviso de privacidad y aceptación (fecha, canal y versión) antes de registrar o procesar; exportación JSON y supresión completa desde la ficha (incluido el contacto de Chatwoot, mediante la cola); anonimización opcional por plazo de conservación; IA sin datos identificativos; respaldo con otro modelo de OpenAI; `docs/rgpd.md` |
| F13 – Gestionar citas por WhatsApp | ✅ | «Mis citas» en el saludo y frases detectadas por reglas; ver, cancelar (con confirmación) y cambiar de fecha moviendo la misma cita en una transacción; antelación mínima por clínica (24 h por defecto, en Ajustes); botones validados contra las citas del propio cliente |
| F14 – Servicios y ausencias | ✅ | Servicios con duración propia (el bot pregunta cuál si hay varios); ausencias de profesionales y cierres de la clínica que bloquean reservas en el bot, en el panel y en la transacción; calendario con ausencias y cierres; datos de demo con festivo y formación |
| F15 – Asistencia y métricas | ✅ | Asistencia de cada cita pasada (marcada por el personal desde Inicio, el calendario o la cita); página de métricas por mes con tasa de no presentados y su evolución, ocupación por profesional y servicios; datos de demo con 6 meses de historial |
| F16 – Notas de voz | ✅ | El bot transcribe las notas de voz con OpenAI (`gpt-transcribe`), repite lo que ha entendido y sigue la conversación como si fuera texto; el audio no se guarda; solo tras aceptar el aviso de privacidad; máximo 2 minutos (configurable); copia en Chatwoot con la transcripción |
| F17 – Lista de espera | ✅ | Si no hay hueco, el bot ofrece «🔔 Avisarme» (el día entero si está completo, o esa hora); cuando se libera un hueco, el primero de la lista recibe una plantilla para reservarlo con un botón y, si no responde en 30 minutos, pasa al siguiente; activable por clínica en Ajustes; lista en Inicio |
| F18 – Rol de profesional | ✅ | Equipo en Ajustes: invitar por email como administrador o como profesional de un empleado; al entrar con ese email se une a la clínica. El profesional solo ve y gestiona sus propias citas (Inicio, calendario, asistencia); las secciones de administración quedan cerradas en el servidor |
| F19 – Aislamiento en la base de datos | ✅ | Rol `clinicai_app` con RLS por clínica: PostgreSQL solo deja ver y cambiar las filas de la clínica de cada petición, aunque al código se le olvide el filtro; sin clínica no ve nada. Conexión aparte (propietario) solo para lo que abarca varias clínicas. Todos los tests del bot y de la web corren ya con el rol restringido |
| F20 – Preparar el despliegue | ✅ | Railway sin `railway.json` (ya no se admite en servicios nuevos y deja de leerse el 01/12/2026): configuración del servicio y variables documentadas. `pnpm preflight`: comprueba sin escribir ni enviar nada la base de datos, los números y plantillas de Meta, los modelos de OpenAI, Kinde, Chatwoot y el bot y el panel desplegados. Guía de despliegue en un solo orden, con la comprobación al final de cada paso |
| F21 – Mejoras pendientes | ✅ | Las cancelaciones, cambios y ausencias quitadas en el panel avisan a la lista de espera en un segundo (tarea interna en la cola del bot). El personal añade clientes a la lista de espera desde Inicio. Cambiar el rol de alguien del equipo sin quitarlo e invitarlo de nuevo |
| F22 – Evaluación de la IA en la CI | ✅ | Workflow «Evaluación IA»: ejecuta `eval/` en modo estricto cuando cambian los prompts, el conocimiento FAQ de FisioDemo o la evaluación, y bloquea el cambio si no se alcanza el objetivo. Se puede lanzar a mano con otro modelo para elegir el sustituto de `gpt-4o-mini`. Informes en la página del *run* y como artefacto. Sin el secreto `OPENAI_API_KEY`, se omite |
| F23 – Importar clientes | ✅ | «Importar CSV» en Clientes: acepta los CSV de Excel en España (`;`, Windows-1252) y los de `,` y UTF-8; reconoce las columnas por su nombre; vista previa con lo que se importará y lo que no (y por qué) antes de guardar nada; aceptación de la privacidad opcional; hasta 2000 filas en una sola operación |
| F24 – Registro de actividad | ✅ | «Registro de actividad» en el menú de la cuenta (propietario y administradores): quién hizo qué y cuándo en el panel (cambios, consultas y exportaciones de fichas) y por WhatsApp (registros, reservas, cancelaciones, lista de espera), con filtro por tipo. Sin nombres, teléfonos, emails de clientes ni notas; se guarda 2 años; la aplicación solo puede añadir entradas |
| F25 – Seguridad antes de producción | ✅ | Política de seguridad de contenido (CSP) estricta en el panel, con un *nonce* por petición: solo se ejecutan sus propios scripts. Cabeceras de seguridad en el panel y en el bot. El e2e entra en la CI y comprueba la política y la accesibilidad (WCAG 2.1 AA) de cada página y de los diálogos principales. Workflow «Dependencias»: vulnerabilidades conocidas cada lunes y cuando cambian las dependencias. `pnpm preflight` comprueba las cabeceras de lo desplegado |
| F26 – Tratamientos y bonos | ✅ | «Repetir» en «Nueva Cita»: una serie de citas a la misma hora en los días elegidos, cada 1 o 2 semanas. Antes de guardar se ven las fechas; las que no están libres se saltan (con su motivo) y se añaden otras al final. Se guardan todas o ninguna. «Sesión 3 de 10» y «Cancelar esta y las siguientes». Bonos de sesiones en la ficha del cliente: se descuenta una al marcar «Asistió» (y «No vino», si la clínica lo elige). El bot responde a «¿cuántas sesiones me quedan?» sin usar la IA |
| F27 – Reservar desde la web | ✅ | Página pública de cada clínica (`/reservar/<dirección>`), que se publica en Ajustes: servicios y huecos libres de 14 días. Al elegir una hora se abre WhatsApp con la cita escrita y una referencia que el bot lee sin IA para ir directo a ese hueco, también tras registrar a un cliente nuevo. QR para el mostrador y botón para la web de la clínica |
| F28 – Agenda en el móvil | ✅ | «Ver en el móvil» en Calendario: un enlace secreto por profesional para suscribirse a su agenda desde Google Calendar, Apple Calendar u Outlook (iCalendar, solo lectura). Citas de 30 días atrás a 6 meses adelante con las iniciales del cliente (o el nombre, si se elige), ausencias y cierres. Cada profesional gestiona el suyo; se puede regenerar y revocar, y se revoca al salir del equipo |
| F29 – Información para el asistente | ✅ | Formulario en Ajustes (dirección, ciudad, horario, pagos, aseguradoras, parking, servicios y precios, información importante) que genera el texto con el que el asistente responde, con la misma plantilla optimizada; sin subir un `.txt`, que sigue disponible como opción avanzada. El texto de FisioDemo que se evalúa es el que genera su información (un test lo comprueba) |
| F30 – Recordatorios configurables | ✅ | Primer recordatorio 1 o 2 días antes a la hora de la clínica, y un segundo aviso opcional el mismo día (2, 3 o 4 horas antes), siempre entre las 8:00 y las 21:00. La plantilla lleva la fecha. Corregido: el cron solo se ejecutaba a las 8:00 y una clínica con otra hora no recibía recordatorios; ahora corre cada 15 minutos |
| F31 – Consola de la plataforma | ✅ | `/plataforma`, solo para los administradores de la plataforma (`PLATFORM_ADMIN_EMAILS`; los demás reciben 404): clínicas, actividad, mensajes, consumo de IA y coste estimado de cada mes. Contadores diarios nuevos (`usage_daily`, solo números, 24 meses): antes el consumo de IA solo quedaba en los logs |
| F32 – Correcciones de seguridad | ✅ | Arreglos P1 de la auditoría de seguridad: el número de WhatsApp de una clínica se comprueba con Meta, `DATABASE_APP_URL` obligatoria en producción, Chatwoot solo con conversaciones del bot, email verificado para invitaciones y consola, respuesta de la IA revisada antes de enviarla, botones de recordatorios antiguos sin efecto y citas fuera de horario solo para administradores. Corregido: el segundo recordatorio compartía bloqueo con la lista de espera |
| F33 – Cadena de suministro | ✅ | Arreglos P2 de la auditoría: acciones de GitHub fijadas por commit y sin credenciales en disco, `permissions` de solo lectura en CI, clave de OpenAI solo en los pasos que la usan, dependencias de Python con hash, imagen del bot con versión y *digest* de Node y pnpm verificado con corepack (y la imagen se construye en cada CI), PostgreSQL de Docker solo en local |
| F34 – Hallazgos bajos de la auditoría | ✅ | Bonos sin carreras con la asistencia, disponibilidad de compañeros oculta a los profesionales, firmas de Chatwoot de menos de 5 minutos, notas de voz solo desde Meta y con límite de tamaño, iCalendar sin caracteres de control, usuario de pruebas solo en `localhost`, invitaciones que caducan a los 14 días y «Salir de la clínica», listados de 100 días como mucho, clave de cifrado de pruebas rechazada, `/health` sin detalles públicos, mensajes de Meta de más de 7 días descartados y citas por WhatsApp hasta 6 meses vista. Plugin de Netlify fijado y sin excepciones de espera mínima en pnpm |

## Decisiones (D1–D7 por defecto del documento, más las siguientes)

### Versiones verificadas (registro npm y documentación oficial, 10/11/2026)
- **TypeScript 6.0.3**, no 7.0: `typescript-eslint` 8.72 solo admite `<6.1`.
- **ESLint 9.39.5**, no 10: `eslint-plugin-react`, `-import` y `-jsx-a11y` (dependencias de `eslint-config-next`) solo admiten ESLint ≤ 9.
- **Prisma 7.10.1** (estable). La etiqueta `latest` de `prisma` apunta a `8.0.0-rc.33` (RC), descartada.
- **FullCalendar 7.1.4**: los plugins (`daygrid`, `timegrid`, `interaction`) son subrutas de `@fullcalendar/react`; el README prohíbe mezclarlo con los paquetes v6.
- **Next.js 16.4.6**: `middleware.ts` pasa a llamarse `proxy.ts`. Kinde (`@kinde-oss/kinde-auth-nextjs` 2.13.2) lo admite con `withAuth` (documentación oficial).
- **WhatsApp Cloud API**: versión Graph vigente **v27.0** (changelog de Meta). Límites: 3 botones de respuesta (título ≤ 20), listas de hasta 10 filas (título de fila ≤ 24).
- **OpenAI**: `gpt-4o-mini` sigue disponible, pero OpenAI lo **retira el 14/01/2027** (sustituto anunciado: `gpt-6-luna`). Se mantiene por defecto (como pide la especificación) y se avisa en `.env.example` y README.
- **pnpm 12**: los scripts de build se aprueban en `allowBuilds` (`pnpm-workspace.yaml`); si no, `pnpm i` falla.

### Entorno local sin Docker
- La máquina de desarrollo no tiene Docker ni PostgreSQL. Se usa **embedded-postgres** (binarios oficiales de PostgreSQL 18 vía npm):
  - `pnpm db:local` levanta un servidor persistente en `:5433` (`.data/postgres`).
  - Los tests de BD arrancan un PostgreSQL efímero por proyecto de Vitest (o usan `TEST_DATABASE_URL`, como en CI con un contenedor de servicio).
- `docker-compose.yml` se mantiene como alternativa (PostgreSQL 17 en `:5432`).

### Modelo de datos (mejoras ➕ sobre la especificación)
- Claves foráneas compuestas `(tenant_id, client_id)` y `(tenant_id, employee_id)` → la BD impide citas con cliente o empleado de otro tenant.
- `clients.phone` es opcional (el panel permite crear clientes sin teléfono); la unicidad `(tenant_id, phone)` se mantiene.
- Tabla ➕ `chatwoot_links` (tenant + teléfono → contacto y conversación de Chatwoot) para el espejo y para resolver el tenant en el webhook de Chatwoot sin depender del formato del payload.
- Borrado de cliente o empleado en cascada sobre sus citas (la web avisa y ofrece desactivar al empleado).
- RLS: migración `enable_rls` activa RLS en todas las tablas y, solo si existen los roles de Supabase `anon`/`authenticated`, revoca permisos y crea políticas restrictivas de denegación.

### Disponibilidad
- Reglas puras en `@clinicai/shared/availability`: un empleado está libre en `[inicio, inicio+duración)` si está activo, una franja de su horario de ese día (zona del tenant) cubre el intervalo completo y no tiene citas no canceladas que se solapen (intervalos semiabiertos).
- Las comparaciones de horario se hacen entre **instantes** (no minutos de reloj), así que el cambio de hora (DST) es correcto.
- Reserva con `bookAppointment`: transacción + `pg_advisory_xact_lock` por empleado → test con 4 reservas concurrentes del mismo hueco: solo una entra.
- Rejilla de huecos: paso `min(slotMinutes, 60)` desde la medianoche local; las sugerencias buscan el mismo día y los 7 siguientes.

### Prompts
- `apps/bot/src/prompts/intent.txt` es el prompt optimizado y evaluado de la especificación (literal), con `{sector}` en lugar de "clínica de fisioterapia".
- `parse-date.txt` es nuevo (6.5), con 10 ejemplos *few-shot*.
- `faq-guard.txt` añade normas anti *prompt injection* al prompt FAQ del tenant.
- La plantilla FAQ por defecto vive en `packages/shared/src/faq-template.ts` (no en un `.txt`), porque también la usa el servidor Next.js (descargar o restaurar en Ajustes), donde leer ficheros en tiempo de ejecución no es fiable en Netlify.
- El prompt FAQ de FisioDemo (6.4, con la regla de reservas adaptada a WhatsApp) está en `packages/db/prisma/seed-data/fisiodemo-faq.txt`, que usa la evaluación. Desde F29 se genera con la plantilla y la información de FisioDemo (`seed-data/fisiodemo.ts`, `pnpm --filter @clinicai/db faq:fisiodemo`).

### LLM
- Un único `OpenAICompatibleProvider` (`POST {baseUrl}/chat/completions`) parametrizado por URL, clave y modelo; `OpenAIProvider` y `DeepSeekProvider` solo fijan nombre y URL por defecto.
- Reintento solo ante errores recuperables (timeout, red, 429, 5xx). Ante un 4xx no se reintenta, pero sí se usa el *fallback*.
- Si un modelo rechaza `temperature` (400), se repite la llamada sin ella (algunos modelos nuevos no la admiten).
- `detectIntent`: un único mensaje `user` con el prompt completo, temperatura 0 y normalización al enum (lo que no sea exactamente `CITA` se trata como `FAQ`).
- `answerFaq`: prompt del tenant + `faq-guard.txt` como `system`, temperatura 0,3.
- `parseDate`: `response_format: json_object`, temperatura 0 y validación con zod (ISO con offset). Una salida inválida se trata como «fecha no entendida».
- No se ha podido verificar en la documentación oficial de DeepSeek (dominio bloqueado para la herramienta de lectura) si `deepseek-chat` sigue vigente; el modelo y la URL son configurables (`DEEPSEEK_MODEL`, `DEEPSEEK_BASE_URL`).

### Motor conversacional (F4)
- Router (`apps/bot/src/engine/engine.ts`), en este orden: lista negra → payload de recordatorio → palabras de escape → estado activo → respuesta de texto a un recordatorio de las últimas 24 h → `mainFlow`.
- Tras una FAQ, un registro o una cita confirmada, la conversación queda en `intention/await` (estado «libre» durante 30 min): el siguiente mensaje se vuelve a clasificar sin volver a saludar.
- El aviso de IA (AI Act) va en el primer mensaje de cada conversación nueva: «Soy su asistente virtual 🤖» al registrarse y «Soy el asistente virtual 🤖 de {clinic}» en el saludo de un cliente conocido.
- Si el mensaje que dispara la cita ya trae fecha («Podría ser pasado mañana a las 12?»), `citaFlow` la usa directamente sin volver a preguntar.
- Una fecha sin hora no cuenta como error: se pregunta la hora. Una fecha pasada tampoco cuenta (se ha entendido).
- Exclusión mutua por conversación dentro de cada instancia (cola por tenant + teléfono) y limitación de 20 mensajes/min por teléfono, también por instancia.
- Mensajes no textuales: se responde que solo se entiende texto y se mantiene el estado.
- Si fallan todos los proveedores LLM: mensaje amable y +1 al contador de errores del flujo.

### Recorrido manual con el simulador (F4)
`printf '…' | pnpm bot:simulate --tenant fisiodemo --phone +34699000001` (LLM mock, 10/11/2026):

```text
👤 Hola
🤖 Bienvenido/a a FisioDemo. Soy su asistente virtual 🤖. Parece que es tu primera vez aquí.
🤖 ¿Quieres comenzar con el registro?
   [#1 Sí]  [#2 No, gracias]
👤 #1
🤖 Perfecto, voy a proceder con algunas preguntas
🤖 Por favor, escribe tu nombre completo:
👤 Ana García López
🤖 ¿Cuál es tu email?
👤 correo-mal
🤖 Ese email no parece válido. Ejemplo: nombre@gmail.com. Inténtalo de nuevo:
👤 ana.garcia@gmail.com
🤖 ✅ ¡Registro completado en FisioDemo, Ana! Ahora puedes pedir tu cita.
👤 ¿Qué horario tenéis?
🤖 Nuestro horario es: lunes a viernes, de 7:00 a 20:00.
👤 Podría ser pasado mañana a las 12?
🤖 ✅ ¡Genial! La fecha jueves, 12 de noviembre de 2026, 12:00 está disponible en FisioDemo.
🤖 Estos son los profesionales disponibles en FisioDemo para esa hora. Selecciona uno o pulsa "Cancelar" para salir:
   [#1 Daniel]  [#2 Marcos]  [#3 Cancelar]
👤 #1
🤖 ✅ Has seleccionado a Daniel en FisioDemo.
   📅 Fecha: jueves, 12 de noviembre de 2026
   🕐 Hora: 12:00
   👤 Profesional: Daniel
🤖 ¿Deseas confirmar la cita, cambiar la fecha o salir?
   [#1 Sí ✅]  [#2 Otra fecha]  [#3 Salir]
👤 #1
🤖 ✅ ¡Cita confirmada en FisioDemo para jueves, 12 de noviembre de 2026, 12:00!
👤 /citas
   ⚙ jueves, 12 de noviembre de 2026, 12:00 · Daniel · Pendiente (pending) · whatsapp
```

### Recordatorios (F5)
- `settings.reminderHour` sí se usa: un tenant solo se procesa cuando su hora local es igual o posterior a `reminderHour`. Con el cron por defecto (08:00 Madrid) se comporta como pide la especificación; con un cron horario (`REMINDER_CRON="0 * * * *"`), cada tenant recibe los recordatorios a su hora. El endpoint manual fuerza el envío por defecto (`force: true`).
- Si WhatsApp falla, la marca `reminder_sent_at` se revierte para reintentar en la siguiente ejecución.
- Una respuesta de texto a un recordatorio de las últimas 24 h se interpreta con reglas de sí/no. Si es corta y ambigua, se reenvían los botones. Si es larga, se trata como una petición nueva.
- En la cita, «mañana» se calcula respecto a la fecha real de la cita (si se responde otro día, dice «el jueves, 8 de mayo…»).

### Chatwoot (F6)
- Verificado en el código fuente de Chatwoot (rama `develop`): la creación de mensajes acepta `content_attributes`, `source_id` y `echo_id`; los mensajes `incoming` solo se permiten en bandejas *API channel*; los webhooks con secreto llevan `X-Chatwoot-Signature: sha256=HMAC(secret, "<timestamp>.<body>")` y `X-Chatwoot-Timestamp`. El webhook admite esa firma o, para versiones sin firma, `?token=<CHATWOOT_WEBHOOK_SECRET>`.
- Anti-bucles: los mensajes que publica el bot llevan `source_id = clinicai-bot:<uuid>` y `content_attributes.clinicai_bot = true`; el webhook descarta esos mensajes y todos los `incoming`.
- El tenant y el teléfono de una conversación se resuelven con la tabla `chatwoot_links` (creada por el propio bot al hacer el espejo). Si no hay enlace, se usan `custom_attributes` de la conversación.
- Contacto de Chatwoot con `identifier = <tenant_id>:<teléfono>`, para que un mismo número en dos clínicas no se mezcle.
- Si WhatsApp rechaza el mensaje de un agente (por ejemplo, ventana de 24 h cerrada, error 131047), se añade una nota privada explicándolo.
- No verificado (documentación de Chatwoot inaccesible para la herramienta): el formato exacto de las respuestas de `GET /inboxes`, `POST /contacts` y `POST /conversations`. El cliente acepta las variantes habituales (`payload[]` o array, `payload.contact.id` o `id`).

### Panel web (F7)
- **Autenticación**: `src/proxy.ts` usa `withAuth(req, { loginPage: '/' })` de Kinde (comprobado en el código del SDK 2.13.2): sin sesión se vuelve a `/`. Los layouts de servidor vuelven a comprobar la sesión y redirigen a `/onboarding` si el usuario no tiene clínica.
- **tRPC**: `protectedProcedure` obtiene `tenantId` solo de `tenant_members` (Kinde `sub`); `authedProcedure` sirve para el onboarding. Los errores de disponibilidad (`SlotUnavailableError`) se traducen a CONFLICT/BAD_REQUEST con mensajes en español.
- **Regla de disponibilidad compartida**: el modal de cita consulta `appointments.checkAvailability` (la misma función que el bot) y marca cada empleado como «disponible» o «no disponible». Fuera de horario, el administrador puede forzar la cita marcando una casilla explícita; un solape con otra cita nunca se puede forzar.
- **Zona horaria**: el calendario recibe las citas como horas de pared del tenant (cadenas ISO sin offset), así muestra la hora de la clínica aunque el navegador esté en otra zona; los clics se interpretan en la zona del tenant.
- **FullCalendar 7**: plugins como subrutas de `@fullcalendar/react`, locale `es`, tema `classic` con sus variables CSS ajustadas a la paleta. En v7, el color del evento va en `color`/`contrastColor` y el contenido en `eventContent`.
- **Tiempo real**: `refetchInterval` de 15 s + `refetchOnWindowFocus` en calendario, próximas citas e inicio (opción por defecto de la especificación). Supabase Realtime queda como mejora opcional: no se ha añadido para no exponer la tabla `appointments` a la clave anónima de Supabase (RLS deniega todo a `anon`).
- **Componentes**: estilo shadcn/ui escritos a mano sobre `radix-ui` (Dialog, AlertDialog, Popover, DropdownMenu, Avatar) y `cmdk` (combobox de clientes); los desplegables simples son `<select>` nativos con el mismo estilo (accesibles y cómodos en móvil).
- **Lint de React Hooks 7**: no se llama a `setState` dentro de efectos; los formularios se inicializan desde props en subcomponentes montados con `key`.
- **e2e**: `pnpm --filter @clinicai/web e2e` (requiere `pnpm build:web` y `pnpm db:local`). Recrea la BD `clinicai_e2e`, arranca `next start` con `AUTH_MOCK_USER` + `ALLOW_AUTH_MOCK=true` (el *mock* se ignora en producción salvo con esa segunda variable) y recorre: crear y editar empleado, crear y editar cliente, crear cita, confirmarla y borrarla, borrar cliente y empleado. Resultado: 2/2 en verde.
- `GET /api/health` (sin BD) para la sonda de Playwright y de Netlify.

### Tests
- `pnpm test`: 191 tests en verde y 29 omitidos (los de LLM real, solo con `LLM_LIVE_TESTS=true`). En Windows, Vitest avisa a veces de que «algo impide cerrar» tras terminar: es el cierre del PostgreSQL embebido. El código de salida es 0; en CI se usa un contenedor de PostgreSQL y no se usa el embebido.

### Evaluación (F8)
- Mismas llamadas que producción: intención con un único mensaje `user` (prompt `intent.txt`, temperatura 0, misma normalización); FAQ con `system` = `fisiodemo-faq.txt` + `faq-guard.txt`, temperatura 0,3.
- Ragas 0.4.3 con su API actual (`ragas.metrics.collections`, `llm_factory`/`embedding_factory`). Versiones fijadas por compatibilidad: `langchain-community==0.4.1` (la 0.4.2 rompe el import de Ragas) y `openai==3.3.0` (por `instructor`/`jiter`).
- Ragas no se instala en Python 3.15 (no hay *wheel* de `pyyaml`): el README recomienda un *venv* con Python 3.11–3.12. `eval_intent.py` y todos los `--dry-run` solo usan la biblioteca estándar.
- **No se han obtenido métricas reales**: no hay clave de OpenAI en este entorno. Los scripts se probaron con `--dry-run`, sin clave (salida 0 con aviso) y contra un servidor local que imita la API de OpenAI (flujo completo, incluidos los reintentos ante 429).

### Despliegue (F9)
- No hay Docker en esta máquina, así que la imagen no se ha construido. Sus pasos se reprodujeron en una carpeta temporal: instalación filtrada `--frozen-lockfile --filter "@clinicai/bot..."` OK, `prisma generate` OK y arranque con `pnpm --filter @clinicai/bot start` en modo producción con `/health` → `{"status":"ok","db":"up"}`. Esa prueba destapó que faltaba copiar `tsconfig.base.json`, ya corregido.
- Railway: la configuración vivía en `apps/bot/railway.json`, con el *root directory* en la raíz del repo (la imagen necesita `packages/`). Las migraciones van como comando previo al despliegue, que es seguro con varias réplicas (Prisma usa un *advisory lock*). En F20 el fichero se quitó: ahora se configura en el servicio.
- Netlify: `netlify.toml` en la raíz instala pnpm 12 y ejecuta `pnpm build:web`. No se ha podido probar un despliegue real (sin credenciales).

### Cola de entrada duradera (F11)

- **Problema:** el webhook respondía 200 a Meta y procesaba el mensaje en memoria. Un reinicio o despliegue en ese momento lo perdía, porque Meta solo reintenta si no recibe 200.
- **Ahora:** `POST /webhook` (y `POST /chatwoot/webhook`) autentican, validan y guardan cada evento en `inbound_events`. Solo entonces responden 200; si la BD falla, responden 500 y Meta reintenta. La unicidad `(source, external_id)` sustituye a `processed_messages`, y la migración copia los IDs ya procesados para no perder la deduplicación durante el despliegue.
- **Procesado:** cada instancia ejecuta `QUEUE_CONCURRENCY` bucles (`bot/queue/worker.ts`). Toman eventos con `FOR UPDATE SKIP LOCKED`, y un evento solo se puede tomar si no hay otro anterior sin terminar de la misma conversación (tenant + teléfono). Eso garantiza el orden y que una conversación nunca se procesa en dos sitios a la vez. Sustituye al bloqueo en memoria por conversación (`KeyedMutex`).
- **Instancia caída:** cada evento tomado tiene una reserva (*lease*) de 30 s que se renueva mientras se procesa. Si la instancia muere, otra lo retoma al caducar. `attempts` hace de *token de fencing*: la instancia antigua ya no puede cerrar ni reprogramar ese evento.
- **Reintentos:** 5 s, 10 s, 20 s, 40 s… hasta `QUEUE_MAX_ATTEMPTS` (5); después el evento queda `failed` con `last_error` durante 30 días. Hay una excepción: si la respuesta no se puede entregar después de guardar el nuevo estado de la conversación, el evento no se reintenta (`ReplyDeliveryError`), porque repetirlo ejecutaría el flujo dos veces. El cliente de WhatsApp ya reintenta los errores temporales antes de llegar ahí.
- **Apagado ordenado:** al recibir `SIGTERM`, el bot deja de aceptar peticiones, termina los eventos en curso y deja el resto en la cola para la siguiente instancia. En Railway hay que dar margen con `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (ver `docs/deploy.md`).
- **Límite por teléfono:** se cuenta en `inbound_events` (eventos del último minuto), así que vale para todas las instancias. Los mensajes que lo superan no se guardan.
- **Protección de datos:** al terminar un evento se borra su contenido (`payload`); los eventos hechos se purgan a los 7 días (siguen sirviendo para deduplicar reintentos de Meta). La tabla tiene RLS y los roles de la API de Supabase no tienen acceso.
- **Observabilidad:** `/health` devuelve `queue: { pending, processing, failedLast24h, lagSeconds }`.
- **Simulador:** usa la misma cola (guarda el mensaje y lo procesa con un *worker* propio). No conviene ejecutarlo a la vez que `pnpm dev:bot` sobre la misma BD: el bot podría quedarse con los mensajes del simulador.
- **Límites que quedan:**
  - El procesamiento es «al menos una vez». Si una instancia muere de golpe a mitad de un mensaje, después de guardar el estado o una reserva, el mensaje se reprocesa al caducar la reserva y la conversación puede saltarse un paso. Con un apagado ordenado no ocurre.
  - El espejo hacia Chatwoot sigue en memoria (si falla, solo se registra).

### Protección de datos (F12)

Guía para las clínicas: [`rgpd.md`](rgpd.md). Decisiones:

- **Aviso antes de recoger datos:** el registro por WhatsApp muestra el aviso de privacidad (responsable, finalidad, IA y derechos, con enlace a la política si está configurada) y los botones «Acepto» / «No acepto». En el cliente se guardan la fecha de aceptación (el momento en que pulsa, no el final del registro), el canal y `PRIVACY_NOTICE_VERSION`. Si no acepta, no se guarda nada.
- **Clientes dados de alta en el panel:** tienen una casilla «Ha aceptado la política de privacidad». Si no está marcada, el bot les muestra el aviso en su primer mensaje y no hace nada más, ni siquiera llamar a la IA, hasta que aceptan. Los recordatorios y las respuestas a ellos siguen funcionando, porque forman parte de la gestión de una cita que ya existe.
- **Un solo botón de borrado:** el plan proponía «Eliminar» y «Borrar todos sus datos» por separado. Lo he unificado: **Eliminar** hace siempre la supresión completa (`eraseClient`), porque conservar restos de la conversación no tenía ninguna utilidad. El texto de confirmación explica todo lo que se borra.
- **Chatwoot:** el panel no tiene sus credenciales, así que el borrado del contacto es una tarea interna (`source = 'internal'`) de la cola de F11, sin teléfono ni nombre, que ejecuta el bot. Según el código fuente de Chatwoot, `DELETE /api/v1/accounts/{id}/contacts/{id}` borra también sus conversaciones en segundo plano y devuelve 422 si el contacto está conectado. El bot trata ese 422 como error temporal (se reintenta) y el 404 como «ya borrado».
- **Conservación:** desactivada por defecto. Si se activa (1, 2, 3 o 5 años), la tarea de mantenimiento anonimiza cada 6 h a los clientes sin citas desde la fecha límite. Se conservan las citas, sin nombre ni notas, para las estadísticas.
- **IA:** el respaldo es otro modelo de OpenAI (`OPENAI_FALLBACK_MODEL`, sin valor por defecto para no inventar uno). DeepSeek solo con `FALLBACK_PROVIDER=deepseek` y con un aviso en el log. `apps/bot/.env.example` ya no trae `ENABLE_FALLBACK=true`. La residencia de datos en la UE de OpenAI está verificada en su documentación y explicada en `rgpd.md`.

### Gestionar citas por WhatsApp (F13)

- **Sin tocar el prompt de intención:** el plan proponía una tercera categoría `GESTION` en el LLM. No la he añadido. El prompt de intención evaluado ya envía a CITA las peticiones explícitas de cambiar o cancelar (su regla 2), y cambiarlo obligaría a repetir la evaluación (`eval/`), que necesita una clave de OpenAI. En su lugar, `detectManageRequest` (reglas, en `engine/matching.ts`) reconoce antes del LLM las peticiones sobre citas existentes. Para ello exige la palabra «cita», «sesión» o «reserva» (o un verbo con pronombre, como «cancelarla») junto a un verbo de cancelar o cambiar, o una consulta del tipo «mis citas» o «¿cuándo tengo cita?». Las peticiones de cita nueva y las preguntas frecuentes siguen yendo al LLM. Efecto secundario positivo: gestionar una cita no consume llamadas al LLM.
- **Saludo:** si el cliente tiene citas próximas, el saludo añade los botones «Mis citas» y «Pedir cita».
- **Cancelar:** pide confirmación y deja la cita como `cancelled`, que desaparece de la lista y del calendario como cualquier cancelación.
- **Cambiar de fecha:** reutiliza el flujo de reserva (fecha → profesional → confirmación) con `rescheduleId`. Como cada paso sustituye los datos del estado, el motor conserva ese identificador mientras dura la reserva (`withBookingContext`). Al confirmar, `bookAppointment` mueve la misma cita (mismo id) en una transacción: vuelve a «Pendiente», se borra `reminder_sent_at` para que llegue el recordatorio de la nueva fecha y se conservan las notas. Si el hueco se ocupa entretanto, la cita original no cambia y el bot pide otra fecha sin perder que es un cambio. «Cancelar» o «Salir» a mitad responden «no cambiamos nada».
- **Antelación mínima:** `settings.minNoticeHours` (0, 2, 6, 12, 24, 48 o 72 h; 24 por defecto, en **Ajustes → Negocio**). Por debajo de ella el bot no cancela ni cambia la cita y da el teléfono de la clínica. Se comprueba al empezar y otra vez al confirmar. La cancelación desde el botón del recordatorio no aplica este límite: es la respuesta prevista al recordatorio.
- **Seguridad:** cada id que llega en un botón se busca entre las próximas citas del propio cliente y de su clínica, así que un botón falsificado no puede tocar citas ajenas (hay un test).

### Servicios y ausencias (F14)

- **Modelo:**
  - `services`: nombre único por clínica y duración de 10 a 480 min. Todos los profesionales hacen todos los servicios.
  - `time_off`: tramo `[starts_at, ends_at)`. Con `employee_id` es la ausencia de un profesional; sin él, un cierre de toda la clínica.
  - `appointments.service_id`: opcional, así que las citas anteriores no cambian.
  - Ambas tablas usan claves foráneas compuestas con el tenant, como el resto. Antes comprobé que Prisma 7.10 acepta una relación opcional con clave compuesta y PostgreSQL (MATCH SIMPLE) no la comprueba cuando `employee_id` es nulo. La relación cita → servicio es `NO ACTION`: un servicio con citas no se puede borrar (se desactiva), pero al borrar una clínica todo cae en cascada en la misma sentencia. Hay `CHECK` para que el final sea posterior al inicio y para la duración.
- **Disponibilidad:**
  - La regla común (`filterAvailableEmployees` y `findFreeSlots` en `shared`) recibe los bloqueos (`TimeBlock`).
  - `getAvailableEmployees`, `findNearbySlots` y `checkEmployeeSlot` los cargan de la base de datos.
  - `bookAppointment` los vuelve a comprobar dentro de su transacción. Ni el bot ni el panel pueden reservar en una ausencia, ni siquiera con «forzar» (`allowOutsideSchedule`).
  - Para no dejar citas sin poder editar, la comprobación solo se aplica cuando la cita se crea o cambia de hueco. Así se pueden seguir editando las notas o el estado de una cita que una ausencia posterior pisa.
- **Días completos:** se guardan como medianoche local a medianoche local (`localDaysRange`), así que los días de 23 y 25 h del cambio de hora tienen su duración real (hay un test).
- **Bot:**
  - Con dos o más servicios activos pregunta cuál, con una lista. Si el mensaje ya traía una fecha («quiero cita el lunes a las 10»), la usa después de elegir el servicio. Si el mensaje nombra un servicio, no pregunta. Con un único servicio activo lo usa sin preguntar.
  - La duración del servicio se aplica a la disponibilidad, a las alternativas y a la cita. La cuadrícula de horas sigue siendo la duración de cita de la clínica.
  - El servicio y la duración se conservan durante toda la reserva mediante el mismo mecanismo que `rescheduleId`. Cambiar una cita por WhatsApp conserva su servicio y su duración.
- **Panel:**
  - **Ajustes → Servicios:** alta, edición, activar o desactivar, y borrar solo si no tiene citas.
  - **Ajustes → Festivos y cierres.**
  - **Empleados:** botón «Ausencias» por profesional, con días completos o unas horas.
  - **Al crear una ausencia,** el panel avisa de las citas que pisa (no las toca).
  - **Calendario:** ausencias rayadas con el color del profesional y cierres sombreados. Activé la fila «Todo el día» de las vistas de semana y día, porque sin ella las ausencias de días completos no se veían allí (lo detecté con capturas).
  - **Diálogo de cita:** selector de servicio con su duración, y aviso en rojo si hay ausencia o cierre, con el botón de crear desactivado.
- **Datos de demo:** tres servicios en FisioDemo (las citas de demo usan «Sesión de fisioterapia»), el festivo del 8 de diciembre y dos días de formación de Inés al mes siguiente.

### Asistencia y métricas (F15)

- **Asistencia en un campo aparte:** el plan hablaba de estados «completada» y «no presentado». Los he guardado en un campo propio, `attendance` (asistió, no se presentó o vacío), en lugar de ampliar el estado. El estado describe la reserva (pendiente, confirmada o cancelada) y la asistencia, lo que pasó después. Así los recordatorios, la disponibilidad y el bot no cambian, y no se pierde si la cita estaba confirmada. En el panel se ve como un estado más, con icono y texto.
- **Marcado:** lo hace el personal, nunca el sistema. Solo se puede marcar una cita que ya ha empezado y no está cancelada (`markAttendance`). Hay botones en una tarjeta nueva de Inicio, «Asistencia por marcar», con las citas pasadas de las dos últimas semanas, y en el diálogo de la cita. Si una cita se cancela o cambia de hora, su asistencia se borra.
- **Métricas** (`getMetrics`, en la zona horaria de la clínica):
  - **Tasa de no presentados:** se calcula solo sobre las citas marcadas. Las pasadas sin marcar se muestran aparte y no cuentan.
  - **Cancelaciones:** sobre el total de citas del mes.
  - **Reservas por WhatsApp:** sobre las citas no canceladas.
  - **Ocupación de cada profesional:** minutos reservados entre los minutos de su horario en el mes, descontando sus ausencias y los cierres (`scheduledMinutes` en `shared`, seguro con el cambio de hora).
  - **Citas por servicio.**
  - **Evolución:** tasa de no presentados de los últimos 6 meses.
- **Página Métricas:** indicadores del mes (con la variación de la tasa frente al mes anterior), lista de ocupación, barras por servicio y gráfico de línea de la evolución. El gráfico tiene información al pasar el ratón o con el teclado y una tabla con los datos. Los colores son el azul de la marca y el rojo de estado, comprobados con un validador de contraste y daltonismo. El gráfico se dibuja al ancho real (en la primera versión se escalaba y la línea y los textos salían el doble de grandes; lo vi en las capturas).
- **Dos errores anteriores corregidos al revisar capturas:**
  - Al editar una cita, el campo «Empleado» (y a veces «Servicio») salía vacío porque las opciones llegaban después de rellenar el formulario.
  - El profesional de la propia cita aparecía como «no disponible», porque su propia cita contaba como ocupada.
- **Datos de demo:** 6 meses de citas con asistencia (con menos ausencias cada mes). Las tres citas pasadas más recientes quedan sin marcar, para que se vea la tarjeta de Inicio.

### Notas de voz (F16)

- **Datos comprobados en la documentación oficial (12/11/2026):**
  - **OpenAI:**
    - Recomienda `gpt-transcribe` para transcribir. `whisper-1`, `gpt-4o-transcribe` y `gpt-4o-mini-transcribe` se apagan el 26/02/2027.
    - El endpoint `POST /v1/audio/transcriptions` acepta `ogg` hasta 25 MB.
    - Con `gpt-transcribe` no se envía `language` (usa `languages`), así que no mando idioma y detecta el español solo. A los modelos anteriores sí se les indica `es`.
  - **Meta:**
    - El webhook solo trae el `id` del audio, sin duración.
    - El enlace de descarga se pide a la Graph API, dura 5 minutos y la descarga también lleva el token.
- **Recorrido:**
  1. El webhook guarda el `id` del audio (nunca el audio).
  2. El motor lo descarga, lo envía a OpenAI y lo descarta. Solo queda el texto, que sigue el mismo camino que un mensaje escrito: palabras de escape, recordatorios, flujos e IA.
  3. La respuesta empieza con «🎤 He entendido: «…»», para que el cliente vea si se ha entendido bien. El eco se corta a 300 caracteres.
- **Antes de aceptar el aviso de privacidad no se procesa nada:** a quien no está registrado, o no ha aceptado, el bot le pide que escriba, sin descargar ni transcribir el audio. El texto del aviso ahora menciona las notas de voz, y su versión ha cambiado a `2026-11-12`.
- **Duración:**
  - Meta no la envía, así que se lee del propio fichero: las notas de voz de WhatsApp son Ogg/Opus y la última página indica la posición de la última muestra a 48 kHz (`utils/ogg.ts`).
  - Además, hay un límite de tamaño (32 KB por segundo permitido), que también cubre los audios en otros formatos.
  - Por encima de `VOICE_MAX_SECONDS` (120 s por defecto), el bot pide una nota más corta o que escriba.
- **Errores:** si la descarga o la transcripción fallan, el formato no es compatible (AAC o AMR) o falta la clave de OpenAI, el bot pide que escriba y mantiene el paso de la conversación. No se reintenta en la cola: así el cliente tiene respuesta al momento.
- **DeepSeek no transcribe:** las notas de voz necesitan `OPENAI_API_KEY`. Sin ella, o con `VOICE_NOTES=false`, el bot pide que escriba.
- **Chatwoot:** la nota se transcribe antes de copiarla, también para los contactos con el bot pausado. Así el agente lee «🎤 texto», ya que con la Cloud API no hay móvil donde escucharla.
- **Registros:** solo la duración y el número de caracteres, nunca el texto (lo comprueba un test).
- **Simulador:** `/audio <texto>` envía una nota de voz que «dice» ese texto; las notas simuladas nunca se envían a OpenAI. `/foto` envía una imagen.

### Lista de espera (F17)

- **Apuntarse:**
  - Cuando la hora pedida no está libre, después de las sugerencias el bot añade el botón «🔔 Avisarme».
  - Si todo ese día está completo, el cliente espera **cualquier hueco de ese día**. Si había otras horas libres, solo **esa hora**, para no ofrecerle huecos que ya ha visto y no ha elegido.
  - Se guardan el servicio y su duración. Máximo 3 esperas activas por cliente, una por día u hora. No se ofrece al cambiar una cita (F13).
- **Avisos:**
  - Un trabajo cada 5 minutos (`WAITLIST_CRON`), y además justo después de cada cancelación o cambio por WhatsApp, busca huecos para cada cliente en espera, por orden de llegada.
  - Si hay varios huecos, ofrece el más cercano a la hora que el cliente pidió.
  - El aviso es una plantilla nueva (`aviso_hueco_libre`, ver [`meta-template.md`](meta-template.md)) con «Reservar» y «No, gracias». También vale contestar «sí» o «no».
  - Cada hueco se ofrece **a una persona cada vez**: queda reservado para ella durante `WAITLIST_OFFER_MINUTES` (30 por defecto) frente al resto de la lista. Si no responde, pasa al siguiente. Las reservas normales nunca se bloquean.
  - Solo se ofrecen huecos con al menos el doble de ese tiempo de antelación (1 hora por defecto), para que dé tiempo a leer el aviso y llegar.
  - Un hueco no se ofrece dos veces al mismo cliente. Si alguien consigue cita ese día por otra vía, su espera se cierra sola.
  - Varias instancias del bot no duplican avisos: *advisory lock* por clínica.
- **Reservar:**
  - Pasa por `bookAppointment`, que vuelve a comprobar la disponibilidad dentro de la transacción. Si el profesional ofrecido ya no está libre, se prueba con otro libre a esa hora.
  - Si el hueco se ha ocupado, el cliente sigue en la lista y esa hora puede volver a ofrecérsele. Un segundo toque no reserva dos veces.
  - La cita queda `pending` y con origen WhatsApp, como cualquier reserva del bot.
- **Panel:**
  - **Ajustes → Lista de espera** (desactivada por defecto, porque necesita la plantilla aprobada).
  - Tarjeta **Lista de espera** en Inicio: quién espera, para qué día u hora y servicio, si tiene un aviso abierto y hasta cuándo, y un botón para quitarlo.
- **RGPD:**
  - Las esperas se exportan con el cliente, se borran al suprimirlo o anonimizarlo, y se eliminan 30 días después de cerrarse.
  - Solo se apuntan clientes que ya aceptaron el aviso de privacidad.
- **Error encontrado al probarlo, ajeno a la lista de espera:**
  - El PostgreSQL embebido de desarrollo y de tests arrancaba con la zona horaria de Windows (`Europe/Paris`). El adaptador `pg` de Prisma envía y lee las fechas sin desfase, así que, con una zona que no es UTC, las horas quedaban desplazadas una hora respecto a `now()` en SQL. Por ejemplo, el límite de mensajes por minuto contaba la última hora y un minuto.
  - Ahora `db:local` y los tests arrancan PostgreSQL en UTC.
  - Al arrancar, el bot avisa en el registro si la base de datos no usa UTC. La documentación de Supabase no indica su zona por defecto: `docs/deploy.md` explica cómo comprobarla y fijarla.
- **Simulador:**
  - Los botones de todos los mensajes de un mismo turno se numeran seguidos (#1…#4), para poder pulsar tanto las sugerencias como «Avisarme».
  - `/lista-espera` ejecuta el trabajo en ese momento.
- **Ajuste visual:** en el móvil, las filas de «Asistencia por marcar» (F15) y de la lista de espera cortaban el nombre del cliente. Ahora los botones bajan a la línea siguiente.

### Rol de profesional (F18)

- **Roles:**
  - **Propietario:** quien creó la clínica; no se puede quitar.
  - **Administrador:** ve y gestiona toda la clínica.
  - **Profesional:** está ligado a un empleado y solo ve sus propias citas.
  - La base de datos exige que un profesional tenga un empleado de su misma clínica y que nadie más lo tenga. Un administrador nunca tiene empleado.
- **Invitaciones (`tenant_invitations`):**
  - En **Ajustes → Equipo**, el propietario o un administrador invita un email como administrador, o como profesional de un empleado que aún no tenga usuario.
  - No se envía ningún correo: la persona entra en el panel con ese email (código de Kinde) y, en su primera visita, la invitación se convierte en su acceso (`findOrClaimMember`, en el contexto de tRPC y en las páginas). Así no hace falta la API de gestión de Kinde.
  - El email se compara en minúsculas. Una persona pertenece a una sola clínica; si ya está en otra, la invitación se queda pendiente.
  - Se puede cancelar una invitación y quitar a cualquiera del equipo, salvo al propietario y a uno mismo. Si se borra un empleado, se borran su usuario de profesional y su invitación.
- **Qué ve un profesional:**
  - **Inicio:** su agenda de hoy, sus pendientes de confirmar y su asistencia por marcar. No ve la lista de espera.
  - **Calendario:** sus citas, sus ausencias y los cierres de la clínica.
  - Puede crear, cambiar y borrar sus citas, y marcar su asistencia. No puede pasar una cita a otro profesional.
  - Para elegir cliente al reservar, recibe solo el nombre y el teléfono (`clients.options`); no abre fichas, ni exporta, ni borra.
  - Empleados, Clientes, Métricas y Ajustes desaparecen del menú, y si se abren por URL redirigen a Inicio.
- **Seguridad en el servidor:**
  - `protectedProcedure` añade `ownEmployeeId` para los profesionales, y todas las consultas de citas lo usan como filtro. `adminProcedure` cierra el resto de secciones.
  - Los tests comprueban cada operación prohibida (`FORBIDDEN`) y que otra clínica no puede tocar el equipo.
- **Datos de demo:** FisioDemo tiene una invitación para `ines@fisiodemo.test` (email ficticio) como profesional Inés.

### Aislamiento en la base de datos (F19)

- **Antes:** la app y el bot entraban con el rol propietario, que no está sujeto a RLS. Solo el código (`tenantId` en cada repositorio y las claves foráneas compuestas) separaba las clínicas.
- **Ahora:**
  - **Rol `clinicai_app`** (migración `tenant_isolation`): sin BYPASSRLS ni propiedad de las tablas.
  - **Una política por tabla:** `tenant_id = clinicai_current_tenant()`, que lee `app.tenant_id` de la transacción en curso.
  - **Permisos mínimos:** en `tenant_config` no puede crear ni borrar clínicas. No hay permisos por defecto, así que una tabla nueva no es visible hasta que una migración la conceda y le ponga su política (falla cerrado).
- **Contexto de clínica:**
  - El trabajo de una clínica corre dentro de `runWithTenant(tenantId, …)`, con `AsyncLocalStorage`.
  - El cliente de la app es un *proxy* sobre Prisma que mete cada consulta en una transacción corta junto con `set_config('app.tenant_id', …, true)`. En las transacciones interactivas lo fija al empezar.
  - Sin contexto, el *proxy* rechaza la consulta (`MissingTenantContextError`), y el rol por sí solo no ve nada.
  - El ajuste es local a la transacción, así que es seguro con el *pooler* de Supabase en modo transacción.
- **Dónde se fija la clínica:** cada procedimiento tRPC de una clínica, cada mensaje del motor de conversación, cada evento de la cola, y cada clínica en los trabajos de recordatorios y de lista de espera.
- **Conexión del sistema (propietario, `DATABASE_URL`):** solo para lo que abarca varias clínicas o aún no tiene clínica:
  - la cola de mensajes entrantes;
  - saber de qué clínica es un número de WhatsApp o una conversación de Chatwoot;
  - la lista de clínicas de los trabajos y el mantenimiento;
  - la sesión del panel (de qué clínica es el usuario) y el alta de clínicas.
- **Tests:**
  - El arnés da a `clinicai_app` una contraseña y expone su URL. Los 193 tests del bot y los 25 de los *routers* trabajan con el rol restringido, como en producción; las comprobaciones de los tests usan la conexión del sistema.
  - `db/tenant-isolation.test.ts` comprueba con el rol restringido:
    - que, sin filtrar por clínica, solo se ven las filas de la clínica del contexto (también con SQL directo y en transacciones);
    - que no se puede escribir en otra clínica ni pasar una fila a otra;
    - que sin contexto no se ve nada, y que contextos simultáneos no se mezclan;
    - mediante el catálogo de PostgreSQL, que toda tabla accesible tiene RLS y política.
  - Los tests e2e también arrancan el panel con el rol restringido. Así apareció un fallo que los tests de los *routers* no veían: Next.js empaqueta el paquete `db` más de una vez (páginas y rutas de la API), y cada copia tenía su propio `AsyncLocalStorage`, mientras que la conexión es única por proceso. Ahora el almacén del contexto también es único por proceso (`Symbol.for` en `globalThis`).
- **Local:** `pnpm db:app-role` da contraseña al rol en la base de datos local (se niega con cualquier otro servidor) e imprime `DATABASE_APP_URL`. Sin esa variable, todo funciona con la conexión del propietario y el bot lo avisa.
- **Supabase** (comprobado en su documentación el 12/11/2026): un rol propio entra por el *pooler* con el usuario `clinicai_app.<project-ref>`, en modo transacción y en modo sesión. Los pasos están en `docs/deploy.md`.
- **Coste:** cada consulta lleva una transacción corta con una sentencia más (milisegundos).

### Preparar el despliegue (F20)

- **Railway** (documentación consultada el 12/11/2026):
  - El fichero de configuración (*Config as Code*, `railway.json`) está obsoleto: los servicios nuevos no pueden usarlo, y en los existentes deja de leerse el **01/12/2026**.
  - Su sustituto, *Infrastructure as Code* (`.railway/railway.ts`, aplicado con la CLI de Railway), no documenta la ruta del Dockerfile ni el tiempo de cierre. No he incluido un fichero que no puedo probar.
  - El servicio se configura en el panel de Railway: comando previo (migraciones), ruta de salud y rutas vigiladas. Dos variables documentadas: `RAILWAY_DOCKERFILE_PATH=apps/bot/Dockerfile` y `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=60` (0 por defecto).
- **`pnpm preflight`** (`apps/bot/src/preflight/checks.ts`):
  - Solo lectura: consultas de lectura a la base de datos y peticiones GET a los servicios. Los tokens van en la cabecera, nunca en la URL, y se comprueba en los tests.
  - **Base de datos:** conexión, UTC, migraciones (las del código frente a `_prisma_migrations`, con las fallidas o pendientes) y el rol de F19: que no se salte el RLS y que sin clínica no vea ninguna fila.
  - **Clínicas:** el token de cada una (si no se descifra, la `ENCRYPTION_KEY` no es la del panel) y su número en Meta, que tiene que estar `CONNECTED`, con su calidad.
  - **Meta:**
    - Con `META_WABA_ID`, las plantillas del recordatorio y de la lista de espera: aprobada ✅, en revisión ⚠️, rechazada, pausada o inexistente ❌. La de la lista de espera solo es obligatoria si alguna clínica la tiene activada.
    - También que haya una app suscrita al webhook (con `META_APP_ID`, que sea esta).
    - Los errores se explican por su `code` de Meta (190 = token, 200 = permisos, 803 = identificador).
  - **OpenAI:** la clave y cada modelo en uso con `GET /v1/models/{model}`. Si el modelo tiene `shutdown_date` a menos de 120 días, avisa. Si OpenAI incluye en esa respuesta la fecha de apagado de `gpt-4o-mini` (14/01/2027), ya avisaría ahora; sin clave no lo he podido comprobar.
  - **Panel:** misma `ENCRYPTION_KEY` y base de datos que el bot, URLs de Kinde coherentes y `/.well-known/openid-configuration` de Kinde accesible.
  - **Chatwoot:** que exista la bandeja.
  - **Bot y panel desplegados:** `/health` y la verificación del webhook con el `VERIFY_TOKEN`. Ese token se manda a la URL del propio bot, tal y como lo hace Meta.
  - Termina con código 1 si algo falla.
- **Datos de Meta confirmados en su documentación** (12/11/2026):
  - La versión actual de la Graph API es v27.0.
  - Las plantillas no se pueden filtrar por nombre en la API: se piden todas, página a página, y se filtran aquí.
  - El identificador de la cuenta de WhatsApp Business no se puede deducir del número: hay que configurarlo.
- **Guía de despliegue:** una sección inicial con el orden de los pasos, una línea «Comprueba» al final de cada paso, y la lista final empieza por `pnpm preflight` sin errores.
- **Probado:**
  - 4 tests con Meta, OpenAI, Kinde y el bot simulados sobre la base de datos de tests (un despliegue listo, los errores habituales y una clave de cifrado distinta).
  - 2 tests de la comparación de migraciones.
  - Contra la base de datos local y el bot real arrancado en local: `/health` y la verificación del webhook correctas, y una `ENCRYPTION_KEY` distinta detectada.

### Mejoras pendientes (F21)

- **Aviso inmediato desde el panel:**
  - El panel no envía WhatsApp. Cuando un cambio puede liberar un hueco, deja una tarea interna `waitlist.check` en la cola del bot (`requestWaitlistCheck`), con el mismo mecanismo que el borrado de contactos de Chatwoot (F12). El *worker* la recoge en un segundo y ofrece los huecos (`processWaitlist`), con la copia en Chatwoot.
  - Cambios que la crean: cancelar una cita, moverla de hora o de profesional, acortarla, borrar una que no estaba cancelada, quitar una ausencia o un cierre, cambiar el horario de un profesional o reactivarlo.
  - Solo si la clínica tiene la lista de espera activada. Si no se puede guardar la tarea, el cambio sigue adelante y lo encuentra la siguiente pasada del trabajo.
- **Añadir desde el panel:**
  - Botón «Añadir» en la tarjeta de Inicio: cliente, servicio, día, hora preferida y, si se quiere, «Solo a esa hora». Sin «Solo a esa hora», se ofrece el hueco de ese día más cercano a la hora elegida.
  - Las mismas reglas que por WhatsApp (`joinWaitlist`): como mucho 3 esperas por cliente y una por día u hora.
  - Además, el cliente tiene que tener teléfono y haber aceptado el aviso de privacidad, porque el bot le escribirá. Solo esos aparecen en la lista para elegir.
  - Al añadirlo se lanza la comprobación, así que, si ese día ya hay un hueco, se le ofrece enseguida.
- **Cambiar el rol** (`changeMemberRole`, Ajustes → Equipo → «Cambiar rol»):
  - Administrador ↔ profesional, o cambiar de empleado.
  - Mismas reglas que las invitaciones: un usuario por profesional, contando las invitaciones pendientes.
  - Ni el propietario ni uno mismo.
  - Se aplica en la siguiente petición de esa persona, porque el contexto de tRPC lee el rol en cada una.
- **Probado:**
  - Tests de los *routers*: tareas creadas al cancelar, mover o borrar (y no sin lista de espera); altas desde el panel con sus reglas; cambio de rol y su efecto en los permisos.
  - Test del servicio de equipo, y test del bot: la tarea interna ofrece el hueco.
  - En el navegador: alta (solo aparecen los clientes con teléfono y aviso aceptado), duplicado rechazado, tarea en la cola y cambio de rol.

### Evaluación de la IA en la CI (F22)

- **Scripts:**
  - `--strict` en `eval_intent.py` y `eval_faq.py`: código de salida 1 si no se alcanza el objetivo (intención ≥ 99 %, FAQ ≥ 0,75 en las dos métricas).
  - En FAQ, también si queda sin puntuar más del 10 % de las filas, porque entonces la media no es fiable.
  - Sin `--strict` siguen midiendo y terminando con 0, como antes.
  - Si existe `GITHUB_STEP_SUMMARY`, el resumen en Markdown se añade a la página del *run*.
- **Workflow `.github/workflows/eval.yml`:**
  - Se ejecuta en *pull requests* y *pushes* a `main` que toquen los prompts, `fisiodemo-faq.txt` o `eval/`.
  - También a mano (`workflow_dispatch`), eligiendo el modelo, el juez de Ragas y qué evaluar.
  - Antes de llamar a la API comprueba los datos y los prompts (`--dry-run`). La parte de FAQ se ejecuta aunque falle la de intención, para tener los dos informes.
  - Los informes se guardan 30 días.
  - Sin el secreto `OPENAI_API_KEY` deja un aviso y termina sin error.
  - El modelo por defecto es la variable del repositorio `OPENAI_MODEL`.
- **Versiones** (consultadas el 12/11/2026):
  - `actions/checkout@v7`, `actions/setup-python@v7` y `actions/upload-artifact@v7`, Python 3.12.
  - Según la documentación de GitHub, un secreto que no existe vale cadena vacía y el contexto `env` se puede usar en el `if:` de un paso. Así se omite el *job* sin clave.
- **Coste estimado:** unos 5 céntimos de dólar por ejecución completa con `gpt-4o-mini`, con los precios de OpenAI de esa fecha. Detalle en `eval/README.md`.
- **Probado:**
  - Con una API simulada (sin red): `--strict` termina con 1 cuando hay un error de clasificación, y con 0 si todo es correcto o sin `--strict`. El resumen llega al fichero de GitHub.
  - `--dry-run` de los dos scripts y validación del YAML del workflow.
- **Pendiente de ti:** añadir el secreto `OPENAI_API_KEY` y la variable `OPENAI_MODEL` en GitHub. La primera ejecución real dará los números con el modelo actual.

### Importar clientes (F23)

- **Lectura del fichero (`shared/clients-import.ts`):**
  - Se decodifica como UTF-8 y, si los bytes no lo son, como Windows-1252 (lo que guarda Excel en España con «CSV delimitado por comas»).
  - El separador se detecta en la cabecera (`;`, `,` o tabulador).
  - Lector CSV completo: comillas, `""`, saltos de línea dentro de comillas, BOM y CRLF.
- **Columnas por su nombre** (sin tildes ni mayúsculas):
  - nombre y, si existen, apellidos, que se unen;
  - teléfono (con preferencia por el móvil, que es el de WhatsApp);
  - email;
  - notas.
  - Las demás se ignoran y se muestran en la vista previa. Si no hay columna de nombre, no se puede importar.
- **Mismas reglas que el alta en el panel:**
  - nombre de 2 a 80 caracteres;
  - teléfono normalizado a E.164 (+34 por defecto);
  - email válido, en minúsculas;
  - notas de hasta 2000 caracteres.
- **Filas que se saltan** (cada una con su motivo): sin nombre, teléfono o email no válidos, teléfono repetido en el fichero y teléfono que ya existe en la clínica. Las filas vacías no cuentan.
- **Dos pasos (`clients.importPreview` y `clients.import`, solo propietario y administradores):**
  - La vista previa no guarda nada.
  - Al confirmar, el servidor vuelve a leer y comprobar el fichero y crea los clientes en una sola sentencia (todos o ninguno). El índice único (clínica, teléfono) evita duplicados aunque alguien cree el mismo cliente a la vez.
- **Privacidad:**
  - Casilla opcional «Estos clientes ya aceptaron la política de privacidad». Si se marca, se guarda como aceptación desde el panel con la versión actual del aviso.
  - Si no se marca, el bot les muestra el aviso en su primer mensaje (F12). Los clientes importados quedan cubiertos por la exportación y el borrado de siempre.
- **Probado:**
  - Tests del lector (separadores, comillas, Windows-1252, columnas, motivos), del servicio (teléfonos existentes solo de la misma clínica, aceptación, reimportar) y del *router* (vista previa, importación, profesional sin permiso).
  - En el navegador, con un CSV como el de Excel: tildes y eñes correctas, 3 importados y 2 saltados con su motivo.

### Registro de actividad (F24)

- **Qué se registra (tabla `activity_log`):**
  - Panel: todas las acciones que cambian algo (citas, clientes, equipo, ajustes, profesionales, servicios, ausencias y lista de espera), y también consultar y exportar la ficha de un cliente. Quién: el email de la persona del panel. La vista previa de la importación no se registra, porque no guarda nada.
  - WhatsApp: registro y aceptación del aviso, reservas, cambios de fecha, cancelaciones, confirmaciones desde el recordatorio y la lista de espera.
  - Sistema: anonimizaciones por el plazo de conservación.
- **Sin datos personales:**
  - Solo identificadores (de la cita, del cliente, del profesional) y una lista cerrada de detalles (`ACTIVITY_SAFE_FIELDS`): estado, hora, asistencia, rol y ajustes numéricos, entre otros.
  - Nunca nombres, teléfonos, emails de clientes, notas, motivos ni el contenido de ficheros.
  - Los nombres se buscan al mostrar el registro, así que se ven los actuales.
- **Panel (`protectedProcedure` en `web/server/trpc.ts`):**
  - Solo se registra lo que termina bien.
  - De las citas se leen antes el cliente, la hora y el profesional, así que una cita borrada también queda descrita.
  - Abrir la misma ficha varias veces en 10 minutos cuenta una vez.
  - Si falla el registro, la acción no falla (queda un aviso en el log).
- **Solo añadir:** el rol `clinicai_app` puede leer, añadir y quitar el enlace al cliente, pero no cambiar ni borrar entradas (permisos por columna). La tarea de mantenimiento purga, con la conexión del sistema, lo que tiene más de 24 meses.
- **RGPD:**
  - Al borrar o anonimizar a un cliente, se quita el enlace a esa persona; la entrada queda, para rendir cuentas.
  - La exportación incluye las entradas del cliente: fecha, acción y si fue el personal o él por WhatsApp, sin el email del personal.
- **Página:** filtro por tipo (citas, clientes, equipo, ajustes, lista de espera), 50 entradas por página con «Cargar más». En el móvil, cada entrada en un bloque.
- **Probado:**
  - Servicio: orden, filtro, cursor, solo añadir con el rol de la aplicación, RGPD y purga.
  - *Router*: sin datos personales, consulta repetida contada una vez, exportación, cita borrada descrita, solo administradores y aislamiento entre clínicas.
  - Bot: registro y cancelación desde el recordatorio, sin datos personales.
  - En el navegador, en escritorio y en móvil.

### Seguridad antes de producción (F25)

- **Política de seguridad de contenido (CSP) del panel** (`src/proxy.ts`, `lib/secure-response.ts`, `lib/security-headers.ts`):
  - Un *nonce* nuevo en cada petición. Next.js lo añade a sus scripts y la política solo deja ejecutar esos y los que cargan ellos (`'strict-dynamic'`). Un script inyectado (XSS) no se ejecuta.
  - Sin `eval` (solo en `next dev`), sin `<object>`, sin `<base>` ajeno, formularios solo hacia el propio panel y nada puede mostrarlo en un marco (*clickjacking*).
  - Estilos con `'unsafe-inline'`: los necesitan los atributos `style` del servidor y las etiquetas `<style>` de sonner y del calendario. Los estilos no ejecutan código.
  - Imágenes de cualquier origen `https:`, por el avatar que da Kinde (Google, Gravatar…).
  - Todas las páginas se generan en cada petición (también la 404), para que lleven el *nonce*.
  - **Kinde:** cuando renueva los tokens, su respuesta reconstruye las cabeceras de la petición desde la original y se perdería el *nonce*. El *proxy* construye su propia respuesta con las *cookies* renovadas (comprobado en un test con Kinde simulado).
  - **zod 4** prueba `new Function('')` para acelerar sus esquemas; con la política, el navegador lo bloquea y lo informa como infracción en cada página. En el navegador se desactiva (`z.config({ jitless: true })`), sin cambio de comportamiento.
  - **Informes:** el navegador envía las infracciones a `/api/csp-report`, que registra solo la directiva, el origen de lo bloqueado y la ruta de la página (nunca la *query* ni fragmentos de código).
  - **Vía de escape:** `CSP_REPORT_ONLY=true` en Netlify pasa la política a modo informe (no bloquea, solo informa) si algo dejara de funcionar en producción. `pnpm preflight` avisa mientras esté así.
  - Se activó primero en modo informe con el e2e, que mostró la infracción de zod; corregida, se pasó a bloquear.
- **Otras cabeceras:**
  - Panel (`next.config.ts`): HSTS (2 años), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` (sin cámara, micrófono, ubicación ni pagos) y `Cross-Origin-Opener-Policy`.
  - Bot: `default-src 'none'` (solo responde JSON y texto), `nosniff`, `DENY`, `no-referrer` y, con `NODE_ENV=production`, HSTS.
- **Rutas protegidas:** el *proxy* pide sesión de Kinde en todas las páginas salvo la portada. Antes lo hacía con una lista de rutas a la que le faltaban `/metrics` y `/activity`, aunque el *layout* ya las protegía.
- **Accesibilidad** (`@axe-core/playwright`, reglas WCAG 2.1 A y AA):
  - Se comprueban las 8 páginas, la vista semanal del calendario, los diálogos de cita, cliente, importación y empleado, y el menú de la cuenta.
  - Corregido:
    - El logo y el menú de la cuenta tenían un nombre distinto del texto visible (la «C» y las iniciales).
    - Los días de otros meses del calendario tenían poco contraste (2,5:1; ahora 4,8:1).
    - El botón «Hoy» se llamaba «Este mes» para los lectores de pantalla, y las vistas se llamaban «Vista del semana». Ahora son «Hoy», «Ver por semana» y «Mes anterior».
    - El menú de la cuenta ya no es modal: ocultaba la página a los lectores de pantalla, pero dejaba enlaces enfocables.
- **e2e en la CI:**
  - Cada test falla si el navegador informa de una infracción de la política (`e2e/fixtures.ts`).
  - Comprueba también que cada página lleva la política y que todos sus scripts tienen el *nonce* de esa petición.
  - Si falla, las trazas se guardan como artefacto 7 días.
- **Dependencias** (workflow «Dependencias»):
  - `pnpm audit --prod --audit-level high` falla con una vulnerabilidad alta o crítica en lo que ejecutan el bot y el panel.
  - El informe del *run* incluye también las de desarrollo y los paquetes con versiones nuevas.
  - Se ejecuta cuando cambian las dependencias y cada lunes.
  - **Sin Dependabot:** crea ramas en GitHub (`dependabot/…`) para sus PR, y aquí solo se trabaja en `main`. Además, GitHub no genera alertas de Dependabot con el formato de *lockfile* de pnpm 12.
  - Estado actual: ninguna vulnerabilidad conocida en producción. Una moderada solo en desarrollo (`minimatch`, a través de `typescript-eslint`).
- **Probado:**
  - Tests de la política, del *proxy* (portada sin Kinde, redirección, renovación de tokens, modo informe, rutas), de los informes, de las cabeceras del bot y del *preflight*.
  - e2e: 13 tests en verde con la política bloqueando.

### Tratamientos y bonos (F26)

- **Tratamientos (series de citas, `appointments.series_id`):**
  - En «Nueva Cita», «Repetir»: días de la semana, cada 1 o 2 semanas y de 2 a 30 sesiones, a la hora, con el profesional y con el servicio de la cita.
  - «Ver fechas» (`planSeries`) aplica a cada fecha las mismas reglas que cualquier reserva (`placementProblem`, extraído de `bookAppointment`): profesional activo, dentro de su horario, sin ausencias ni cierres y sin otra cita.
    - Las fechas que no se pueden se saltan, con su motivo, y el patrón sigue hasta completar las sesiones (como mucho 8 semanas más).
    - Si no se completan, se dice cuántas se han encontrado.
  - «Reservar N sesiones» (`bookSeries`): en una sola transacción, con el bloqueo del profesional, vuelve a calcular las fechas.
    - Si ya no coinciden con las que se vieron (alguien reservó mientras tanto), no guarda ninguna y pide revisar la nueva propuesta.
  - Los profesionales crean tratamientos solo en su agenda, como sus citas. Cada sesión tiene su recordatorio normal.
  - En la cita: «Sesión 3 de 10 del tratamiento» (contando las no canceladas) y «Cancelar esta y las siguientes». Esto cancela las que no tienen la asistencia marcada y avisa a la lista de espera.
- **Bonos (`client_packs`):**
  - **Gestión:** en la ficha del cliente (propietario y administradores). Nombre, sesiones (1–100), servicio opcional (sin él vale para cualquiera) y último día de uso opcional. Sin precios ni cobros.
  - **Cuándo se gasta una sesión:** al marcar «Asistió» (`markAttendance`, en la misma transacción). Se gasta del bono vigente más antiguo con sesiones que valga para el servicio de la cita.
    - Una cita sin servicio puede usar cualquier bono.
    - La cita guarda qué bono gastó (`appointments.pack_id`), con una clave foránea que exige que sea del mismo cliente.
    - Un bloqueo por cliente evita que dos marcas a la vez gasten la última sesión dos veces.
  - **Devolución:** desmarcar, cancelar o mover la cita devuelve la sesión.
  - **«No vino»:** solo gasta sesión si la clínica lo activa en Ajustes («Las ausencias sin avisar descuentan una sesión del bono»).
  - **Límites de edición:** no se puede bajar de las sesiones usadas ni cambiar el servicio de un bono usado. Solo se borra si no tiene sesiones usadas.
  - **Dónde se ve:** en la ficha, sesiones usadas, caducidad, estado (vigente, agotado, caducado) y en qué citas se usó.
    - En el diálogo de la cita: «Bono «X»: quedan 6 de 10» o «Sesión descontada del bono…».
    - Al marcar la asistencia, un aviso dice cuántas quedan.
- **Bot:**
  - «¿Cuántas sesiones me quedan?», «¿me queda algo del bono?», «mi bono»… se detectan con reglas antes de la IA (`detectPackRequest`, después de «mis citas»), así que el prompt evaluado no cambia.
  - Las preguntas de precios, huecos libres o reservas no cuentan y siguen a la IA.
  - Responde con las sesiones de cada bono vigente y hasta cuándo vale. Sin bonos vigentes, dice si el último se agotó o caducó, o que no tiene ninguno.
  - Solo a clientes que aceptaron el aviso de privacidad.
- **RGPD:** los bonos se exportan con el cliente (también qué citas gastaron cada sesión) y se borran con él. Al anonimizarlo se conservan, porque no tienen datos personales.
- **Registro de actividad:** crear tratamiento, cancelar las siguientes y alta, edición y borrado de bonos.
- **Datos de demo:** Laura tiene un «Bono 10 sesiones» con 4 usadas.
- **Accesibilidad:** los textos de los avisos (sonner) no llegaban al contraste 4,5:1 sobre su fondo de color; ahora tienen colores más oscuros. Lo detectó el e2e al revisar el diálogo de bonos con un aviso a la vista.
- **Probado:**
  - Fechas: días, cada 2 semanas, cambio de hora y límites.
  - Plan con conflictos, cierres, ausencias, fuera de horario y pasadas.
  - Reserva todo o nada.
  - «Cancelar las siguientes».
  - Bonos: bono elegido, caducidad en la zona de la clínica, «No vino», devolución, límites, clave foránea entre clientes, aislamiento con RLS y RGPD.
  - *Routers*: permisos de profesional y de administrador, y registro de actividad.
  - Bot: respuestas y reglas.
  - e2e: crear bono y tratamiento, «Sesión 2 de 3» y cancelar las siguientes, con accesibilidad.

### Reservar desde la web (F27)

- **Página pública** (`app/reservar/[slug]`, sin sesión y de solo lectura):
  - **Publicación:** cada clínica la publica en **Ajustes → Página de reservas** y elige la dirección (`tenant_config.public_slug`, única; por defecto sale del nombre de la clínica). Hace falta el número de WhatsApp de la clínica. Viene desactivada (`settings.bookingPageEnabled`).
  - **Qué muestra:** servicios con su duración (si hay varios, primero se elige uno) y los huecos libres de 14 días, con las mismas reglas que el bot (`findNearbySlots`).
    - Empieza una hora después de ahora, para que dé tiempo a escribir.
    - Por días, con enlaces normales: no necesita JavaScript propio ni cookies.
  - **Qué no muestra:** nombres de profesionales ni ningún dato de clientes. No guarda nada. Enlaza la política de privacidad de la clínica si está configurada.
  - **Seguridad:** la misma política de seguridad (CSP) que el panel. Una dirección desconocida o sin publicar devuelve 404. La clínica se busca con la conexión del sistema; el resto se lee dentro de su contexto, con el rol restringido.
- **Del hueco a WhatsApp:** cada hora es un enlace `wa.me` con el mensaje escrito, por ejemplo «Hola, quiero pedir cita para Fisioterapia el miércoles, 18 de noviembre de 2026 a las 10:00 (ref. W-261118-1000-3f2a9c1d)».
  - La referencia lleva la fecha y hora locales y un código de 8 cifras del servicio. El código sale de todo el identificador (FNV-1a): los servicios de demo empiezan igual y con un prefijo no se distinguían.
- **Bot:**
  - Lee la referencia con reglas (`readWebBookingRef`), sin IA, y va directo a ese hueco (`citaFlow.startAt` → `checkSlot`): profesionales libres, o los huecos más cercanos si ya se ha ocupado.
  - Si el servicio ya no existe, o el código coincide con más de uno, sigue la reserva normal.
  - **Cliente nuevo:** antes de aceptar el aviso solo se guarda el código de la referencia en el estado de la conversación (30 min). Tras registrarse, o tras aceptar el aviso si lo creó el panel, sigue con ese hueco sin repetir nada.
  - **Conversación en marcha:** si llega una referencia, empieza una reserva nueva con ella, sin heredar un cambio de cita abierto.
- **Panel:**
  - Enlace con «Copiar enlace».
  - Código QR (paquete `qrcode`, versión fijada) para ver y descargar en SVG y PNG.
  - Código HTML de un botón «Pedir cita» para la web de la clínica: es un enlace, sin scripts ni marcos.
  - La dirección pública es la de `KINDE_SITE_URL`.
- **Datos de demo:** FisioDemo tiene la página publicada en `/reservar/fisiodemo`.
- **Accesibilidad:** al pasar el ratón, los botones azules y rojos se aclaraban y bajaban del contraste 4,5:1. Ahora se oscurecen. Lo detectó el e2e con el ratón sobre «Guardar».
- **Probado:**
  - Referencia (ida y vuelta, otras zonas, códigos distintos con identificadores parecidos), dirección, mensaje y enlace.
  - Huecos por día (ocupados, cierres, la primera hora, servicios largos, 14 días).
  - Publicación: número de WhatsApp, dirección no válida o repetida, QR y registro de actividad.
  - Página: servicio, días, horas y enlace.
  - Bot: cliente registrado sin IA hasta reservar con el servicio y su duración; cliente nuevo y cliente sin aceptar; hueco ocupado; conversación en marcha.
  - e2e: publicar, abrir la página, enlace, accesibilidad, CSP y 404.

### Agenda en el móvil (F28)

- **Enlace** (`calendar_feeds`, uno por profesional): `…/api/calendar/<token>.ics` y su versión `webcal://` para añadirlo con un toque en el iPhone.
  - El token tiene 256 bits aleatorios. Se busca por su SHA-256 y se guarda cifrado con `ENCRYPTION_KEY`, para poder enseñarlo otra vez en el panel.
  - Se registra el último uso, como mucho una vez por hora.
- **Gestión** (Calendario → «Ver en el móvil»):
  - Cada profesional gestiona el suyo; el propietario y los administradores eligen de qué profesional.
  - «Crear enlace nuevo» invalida el anterior, y «Revocar» lo borra.
  - Se borra también al quitar a esa persona del equipo, o al cambiarla a otro profesional o a administrador, para que no siga viendo esa agenda desde su móvil. Al borrar el profesional, se borra con él.
- **Contenido** (iCalendar, RFC 5545, generado sin dependencias en `shared/ical.ts`):
  - Citas no canceladas de 30 días atrás a 6 meses adelante, con el servicio y el estado (pendiente o confirmada).
  - Del cliente, sus iniciales («L. M.»), o el nombre completo si se marca la casilla. Nunca el teléfono, el email ni las notas.
  - Ausencias del profesional, sin el motivo, porque puede ser de salud; y cierres de la clínica, con su motivo. Los días completos aparecen como eventos de día entero.
  - Formato: líneas CRLF plegadas a 75 octetos sin partir caracteres, textos escapados y horas en UTC.
- **Sin sesión:** el enlace se busca con la conexión del sistema y la agenda se lee dentro de la clínica, con el rol restringido. Un enlace desconocido o revocado devuelve 404. El enlace nunca va al registro de actividad (solo quién lo creó, cambió o revocó, y de qué profesional).
- **Probado:**
  - Generador iCalendar (escape, plegado, días enteros, iniciales).
  - Servicio: crear, mostrar de nuevo, regenerar, revocar, último uso, contenido, revocación al salir del equipo y aislamiento con RLS.
  - *Router* y respuesta: permisos del profesional y de los administradores, iniciales o nombre, regenerar, revocar y registro sin el enlace.
  - e2e: crear el enlace desde Calendario, descargar la agenda, revocar (404) y accesibilidad.

### Información para el asistente (F29)

- **Formulario** (Ajustes → «Información para el asistente», `settings.assistantInfo`):
  - Dirección, ciudad, horario (vacío: se calcula de los horarios de los profesionales), formas de pago, aseguradoras y parking.
  - Servicios y precios, una línea por servicio. La primera vez se rellena con los servicios del panel y su duración, para añadir el precio.
  - Información importante, en líneas.
  - El nombre, el teléfono, el sector y los profesionales salen del panel.
  - Cada campo tiene un tamaño máximo, y el texto resultante queda por debajo de 20 KB (comprobado en un test con todo al máximo).
- **Texto del asistente:** la plantilla optimizada de FisioDemo (`shared/faq-template.ts`) rellena con esa información. Lo vacío queda como «Consultar por teléfono».
  - La plantilla añade la ciudad («ubicada en Alicante»; «ubicado» si el sector es masculino) y las líneas de «Información importante» antes de la que siempre va.
  - En Ajustes se ve el texto exacto y se puede descargar.
- **Texto propio (avanzado):** un `.txt` subido sigue teniendo prioridad. La tarjeta indica «Texto propio» o «Formulario», y con «Usar el formulario» se vuelve.
- **Evaluación:**
  - Los datos de FisioDemo (profesionales, servicios e información) están en `prisma/seed-data/fisiodemo.ts`, que usan el seed y la evaluación.
  - `fisiodemo-faq.txt` se genera con `pnpm --filter @clinicai/db faq:fisiodemo`, y un test comprueba que es exactamente lo que el bot construye.
  - Si cambian la plantilla o los datos, el test falla hasta regenerarlo, y el nuevo texto lanza el workflow «Evaluación IA».
  - Al generarlo, el único cambio frente al anterior es el orden de los profesionales (alfabético, como en el panel).
- **Probado:**
  - Plantilla: con información, vacía, sector masculino y límites.
  - Texto de FisioDemo igual al evaluado.
  - *Router*: guardar, validar, texto generado, prioridad del texto propio y registro.
  - Bot: responde con la dirección y los pagos del formulario, y con el texto propio cuando lo hay.
  - e2e: rellenar el formulario y ver el texto, con accesibilidad.

### Recordatorios configurables (F30)

- **Primer recordatorio** (`reminder_sent_at`):
  - Solo para citas pendientes, porque pide confirmar.
  - A partir de la «Hora de los recordatorios» de la clínica, para las citas de los próximos 1 o 2 días (`settings.reminderDaysBefore`). Así, una cita reservada después de que saliera el recordatorio de su día también lo recibe.
- **Segundo aviso opcional** (`second_reminder_sent_at`, `settings.secondReminderHours`: 2, 3 o 4 horas antes; desactivado por defecto):
  - Para citas pendientes y confirmadas, el mismo día.
  - No se envía si la cita se reservó dentro de ese margen.
  - Una respuesta escrita («no puedo ir») se aplica a esa cita aunque estuviera confirmada.
- **Ventana:** nada sale antes de las 8:00 ni después de las 21:00 (hora de la clínica). Si el segundo aviso cae antes de las 8:00, sale a las 8:00; una hora de recordatorio posterior a las 20:00 alarga el final.
- **Error corregido:** el cron interno se ejecutaba solo a las 8:00 (`0 8 * * *`) y saltaba las clínicas cuya hora no había llegado. Una clínica con los recordatorios a las 10:00 no los recibía nunca. Ahora `REMINDER_CRON` es `*/15 * * * *`; la hora de cada clínica y las marcas evitan duplicados, también con varias instancias.
- **Plantilla:** «Hola {{1}}, te recordamos tu cita en {{2}} el {{3}} a las {{4}}.», con la fecha («jueves, 19 de noviembre») en vez de «mañana». La misma plantilla sirve para los dos avisos. `pnpm preflight` comprueba que la aprobada tenga las cuatro variables. Mover una cita rearma los dos avisos.
- **Cron externo:** `POST /jobs/reminders/run` sigue forzando por defecto (para lanzarlo a mano). Un cron externo debe llamarlo cada 15 minutos con `{"force": false}`.
- **Probado:**
  - Dos días antes.
  - Segundo aviso: quién lo recibe, el margen y las citas reservadas tarde.
  - La ventana de 8:00 y 21:00.
  - Respuesta escrita a un segundo aviso de una cita confirmada.
  - Mover una cita rearma los avisos, y el cron por defecto.
  - *Preflight* con la plantilla antigua.
  - *Router* con valores válidos y no válidos.

### Consola de la plataforma (F31)

- **Acceso:**
  - Solo los emails de Kinde de `PLATFORM_ADMIN_EMAILS` (separados por comas). Cualquier otro usuario recibe 404.
  - El enlace «Consola de la plataforma» del menú de la cuenta solo les aparece a ellos.
  - Funciona sin pertenecer a ninguna clínica: la página de alta también tiene el enlace.
- **Contadores** (`usage_daily`: clínica, día UTC, métrica y modelo; solo números):
  - mensajes recibidos (una vez por mensaje, aunque se reintente), respuestas enviadas y plantillas (recordatorios y ofertas de la lista de espera);
  - peticiones y tokens de IA por modelo, también los del modelo de respaldo;
  - segundos de notas de voz transcritas.
- **Cómo se guardan:**
  - En segundo plano y con la conexión del sistema: un fallo al contar no afecta a la conversación.
  - El rol de la aplicación (`clinicai_app`) no tiene permisos sobre la tabla, así que las clínicas no la ven.
  - El mantenimiento borra los de más de 24 meses.
- **Qué muestra, por mes (selector de mes):**
  - **Resumen:** clínicas y cuántas tuvieron actividad, mensajes, citas reservadas, peticiones de IA, coste estimado de IA y de WhatsApp.
  - **Por clínica:** alta y email del propietario, equipo, clientes, WhatsApp (número y token propios, solo número o sin configurar), página de reservas, citas reservadas en el mes (por WhatsApp o desde el panel), mensajes, IA, coste estimado, último mensaje recibido y mensajes fallidos en 24 h.
  - Solo lectura: no se entra en ninguna clínica ni se ve ningún dato de sus clientes.
- **Costes:** estimados en dólares con los precios de lista de noviembre de 2026.
  - OpenAI: `gpt-4o-mini` 0,15 $ y 0,60 $ por millón de tokens (entrada y salida); `gpt-6-luna` 0,10 $ y 0,50 $; `gpt-transcribe` 0,0045 $ por minuto.
  - WhatsApp (Meta, España, desde el 1 de octubre de 2026): plantilla de utilidad 0,02 $; respuesta (mensaje de servicio) 0,02 $ a partir de la 1.001 del mes de cada número. Se supone un número por clínica.
  - `PLATFORM_PRICES` (JSON) cambia o añade precios; un valor no válido se ignora y la consola lo avisa. Un modelo sin precio (por ejemplo, DeepSeek) muestra su consumo sin coste.
  - `pnpm preflight --web-env` comprueba las dos variables.
- **Antes no se guardaba:** el consumo de IA solo iba a los logs y los mensajes de la cola se borran a los 7 días. Los meses anteriores a F31 no tienen datos de uso.
- **Probado:**
  - Contadores: suma concurrente, día UTC, purga y que el rol de la aplicación no puede leerlos.
  - Resumen por clínica: cifras del mes y que no lleva datos de clientes.
  - Bot: mensajes por la cola, plantillas, segundos de voz y tokens de IA (también del modelo de respaldo y de DeepSeek).
  - Precios: cálculo, franquicia de respuestas y `PLATFORM_PRICES`.
  - Panel: quién es administrador, el mes elegido y los costes.
  - *Preflight* de las variables.
  - e2e: abrir la consola desde el menú, cambiar de mes, accesibilidad y CSP.

### Correcciones de seguridad (F32)

Arreglos de prioridad P1 de la auditoría de seguridad del 13 de noviembre de 2026. No había hallazgos críticos ni altos.

- **Número de WhatsApp de cada clínica:**
  - Los mensajes entrantes se asignan a una clínica solo por el `phone_number_id`, así que antes una clínica podía registrar el de otra y recibir los mensajes de sus pacientes.
  - Ahora, al guardar un número nuevo (o un token nuevo), el panel pregunta a Meta (`GET /{phone_number_id}`) con el token propio de la clínica. Si Meta no lo reconoce, no se guarda. Si el número que devuelve Meta no coincide con el «Número de WhatsApp del negocio», tampoco; si ese campo está vacío, se rellena con el de Meta.
  - Sin token propio (se usa el global de la plataforma), solo un administrador de la plataforma puede asignar el número.
  - Si Meta no responde, no se guarda. Con `WHATSAPP_MODE=mock` en el panel (desarrollo) no se pregunta a Meta.
- **Base de datos:** en producción, el bot y el panel no arrancan sin `DATABASE_APP_URL` (antes la protección por clínica de PostgreSQL se desactivaba sin aviso en el panel). `ALLOW_OWNER_CONNECTION=true` lo permite a propósito; `pnpm preflight` avisa si está puesto.
- **Chatwoot:** solo se atienden las conversaciones que creó el bot (`chatwoot_links`). Antes, si no estaba registrada, se tomaban la clínica y el teléfono de los atributos de la conversación, que puede editar cualquier agente; con un Chatwoot compartido, un agente podía enviar mensajes desde el número de otra clínica.
- **Email verificado:** el email solo sirve para recoger una invitación o entrar en la consola de la plataforma si Kinde dice que está verificado (`email_verified` del token de identidad). Con el código por email siempre lo está; protege si un día se activa otro tipo de acceso.
- **Respuesta de la IA a las preguntas frecuentes:** antes de enviarla, el código comprueba que no pase de 700 caracteres, que no tenga enlaces, emails ni teléfonos que no estén en el texto de la clínica, que no repita las instrucciones del sistema y que no diga que ha reservado, confirmado o cancelado nada. Si falla, el bot contesta con un texto fijo y el teléfono de la clínica, y el registro técnico guarda solo el motivo. No cambia ningún prompt evaluado.
- **Botones de los recordatorios:** sobre una cita que ya ha empezado no cambian nada («Esa cita ya ha pasado…»). «Sí, confirmo» solo confirma una cita pendiente (escritura condicional): una cancelada mientras tanto sigue cancelada. «No puedo asistir» sigue funcionando dentro del plazo de aviso.
- **Citas fuera de horario:** forzarlas es cosa de propietario y administradores; a un profesional no le aparece la casilla. Editar una cita sin moverla (mismo profesional, hora y duración) no lo necesita.
- **Error corregido:** el segundo recordatorio (F30) usaba el mismo número de bloqueo que la lista de espera (`802_402`): si coincidían, uno de los dos se saltaba esa vuelta. Ahora todos los números están en `db/services/locks.ts` y un test comprueba que no se repiten.
- **Pendiente (P2):** fijar las acciones de GitHub por SHA, `permissions` en `ci.yml`, clave de OpenAI solo en sus pasos, hashes en las dependencias de Python, imagen del bot por *digest* y el PostgreSQL de Docker solo en local.
- **Probado:**
  - Meta: respuesta correcta, token no válido, número desconocido, sin respuesta y modo simulado.
  - Panel: número rechazado, número distinto, número correcto (rellena el teléfono), guardar sin cambios sin preguntar a Meta, sin token propio y email sin verificar.
  - Invitación con email sin verificar.
  - Citas fuera de horario de un profesional y de un administrador, y editar sin mover.
  - Chatwoot: conversación ajena y otra cuenta.
  - Respuesta de la IA: comprobaciones y conversación completa.
  - Botones sobre citas pasadas y confirmación tardía.
  - `DATABASE_APP_URL` en producción, números de bloqueo y *preflight*.

### Cadena de suministro (F33)

Arreglos de prioridad P2 de la auditoría de seguridad: nada de esto cambia lo que hace la aplicación, solo cómo se construye.

- **GitHub Actions:**
  - Cada acción se fija por el SHA de su commit, con la versión en un comentario (`actions/checkout` v7.0.1, `setup-node` v7.1.0, `setup-python` v7.1.0, `upload-artifact` v7.0.2). Una etiqueta se puede mover; un commit no. `ci.yml` usaba la v5 de `checkout` y `setup-node`: ahora los tres workflows usan las mismas.
  - `persist-credentials: false`: el token de GitHub no se queda en el disco del job después de descargar el código.
  - `ci.yml` tiene `permissions: contents: read`, como ya tenían los otros dos.
  - Para actualizar una acción: buscar el commit de la nueva etiqueta (`gh api repos/actions/<acción>/git/ref/tags/<versión>`) y cambiar SHA y comentario.
- **Evaluación IA (`eval.yml`):**
  - La clave de OpenAI solo llega a los dos pasos que llaman a la API. El resto del job solo sabe si existe (`HAS_OPENAI_KEY`).
  - Las dependencias se instalan desde `eval/requirements.lock` con `--require-hashes` (96 paquetes, también los indirectos), generado con uv para Linux y Python 3.12. Todos tienen rueda para esa plataforma, así que no se compila nada. Cómo regenerarlo: `eval/README.md`.
  - El nombre del informe solo admite letras, números, `.`, `_` y `-`, aunque el modelo se escriba a mano.
- **Imagen del bot:**
  - `node:24.22.3-slim` con su *digest*: la imagen es siempre la misma. Contrapartida: no recibe sola los parches de Node; hay que actualizarla a mano (`docs/deploy.md`).
  - pnpm se instala con corepack y se verifica con el hash de `packageManager` en `package.json` (`pnpm@12.18.0+sha512.…`), en vez de `npm install -g`. Queda en `/corepack`, así que el usuario `node` lo usa sin red (arranque y migraciones).
  - Nuevo job `image` en CI: construye la imagen y comprueba que pnpm funciona en ella sin red. Antes el Dockerfile solo se construía al desplegar.
- **Docker en local:** el PostgreSQL de `docker-compose.yml` escucha solo en `127.0.0.1`; antes, con la contraseña por defecto, era accesible desde la red local.
- **Sin cambios:** Netlify sigue instalando pnpm con `npm install -g` (no se puede probar hasta el primer despliegue).
- **Probado:**
  - Ningún `uses:` sin SHA en los workflows.
  - El lock resuelve las mismas versiones solo con ruedas.
  - pnpm local acepta `packageManager` con hash.
  - La imagen y la evaluación se comprueban en GitHub Actions; la evaluación necesita el secreto `OPENAI_API_KEY`.

### Hallazgos bajos de la auditoría (F34)

Los hallazgos de prioridad baja que quedaban de la auditoría del 13 de noviembre de 2026.

- **Arreglados en el código:**
  - **Bonos:** editar o borrar un bono toma el mismo bloqueo que marcar la asistencia: ya no se puede gastar una sesión de un bono que se está borrando ni pasar del total.
  - **Profesionales:** al comprobar disponibilidad solo ven la suya (`checkAvailability`).
  - **Chatwoot:** se rechazan las firmas de hace más de 5 minutos (o de más de 5 minutos en el futuro); el registro técnico oculta también la cabecera y el `?token=` de Chatwoot y las claves anidadas.
  - **Notas de voz:** solo se descargan por https de dominios de Meta (`fbsbx.com`, `fbcdn.net`, `facebook.com`, `whatsapp.net`); las redirecciones se siguen a mano dentro de esos dominios y sin el token, y la descarga se corta al pasar el límite aunque Meta no diga el tamaño.
  - **iCalendar:** se quitan los retornos de carro sueltos, los caracteres de control y los separadores de línea Unicode.
  - **Errores de tRPC** (solo en desarrollo): una línea JSON.
  - **Usuario de pruebas** (`AUTH_MOCK_USER`): solo si la dirección del panel (`KINDE_SITE_URL`) es `localhost` (`lib/auth-mock.ts`).
  - **Invitaciones:** caducan a los 14 días; salen como «Invitación caducada» y volver a invitar al mismo email la sustituye. Cualquier miembro que no sea el propietario puede «Salir de la clínica» desde el menú de la cuenta (registrado como «Salió de la clínica»).
  - **Listados del calendario:** como mucho 100 días por consulta.
  - **Clave de cifrado de pruebas** (todos los bytes iguales, como la de ceros del CI): `pnpm preflight` falla y el bot lo avisa al arrancar.
  - **`/health` del bot:** sin `x-cron-secret`, solo `{status, db}`; `pnpm preflight` envía el secreto.
  - **Webhook de Meta:** se descartan los mensajes de más de 7 días (la ventana de reintentos de Meta y del registro de duplicados).
  - **Citas por WhatsApp:** como mucho 6 meses vista (`BOOKING_HORIZON_DAYS`); el panel no tiene límite.
- **Dependencias:**
  - `@netlify/plugin-nextjs` 5.16.6 fijado en el `package.json` de la raíz, así que Netlify usa la versión del fichero de bloqueo.
  - Quitadas las excepciones a la espera mínima de pnpm: esas versiones ya la cumplen y pnpm verifica las 830 entradas del fichero de bloqueo sin ellas.
- **Se quedan como están (y por qué):**
  - Límite de peticiones en las páginas públicas: en Netlify o en un CDN, no en el código (`docs/deploy.md`).
  - Profesionales que ven todos los clientes y la pista de sus bonos: por diseño, reservan para cualquier cliente.
  - El texto del asistente lo controla la clínica: por diseño (`docs/rgpd.md`).
  - Mensaje del cliente sin delimitar en los prompts de intención y fecha: cambiarlos obliga a repetir la evaluación con OpenAI.
  - `crypto-js` y `jsrsasign` llegan con Kinde; «Dependencias» no bloquea porque no hay pull requests; la imagen del bot necesita sus dependencias de desarrollo.
- **Probado:**
  - Bono borrado a la vez que se marca la asistencia (5 rondas).
  - Firmas de Chatwoot viejas, futuras y válidas.
  - Notas de voz: URL fuera de Meta, redirección a la CDN sin token y descarga sin tamaño.
  - iCalendar con un retorno de carro suelto.
  - Usuario de pruebas.
  - Disponibilidad de un profesional, caducidad de invitaciones, salir de la clínica y rango de los listados.
  - Clave de pruebas y `/health` con *preflight*.
  - Mensaje de Meta de 8 días.
  - Fecha a 6 meses.

### Recorrido completo de la aplicación (13 de noviembre de 2026)

Prueba de extremo a extremo con el panel (compilación de producción) y el bot funcionando, en una base de datos aparte, con WhatsApp e IA simulados (`pnpm bot:simulate`, que pasa por la misma cola que el webhook):

- **Recorrido:** alta de la clínica → ajustes, información para el asistente, número de WhatsApp, servicios, profesionales y página de reservas → paciente nuevo por WhatsApp (aviso de privacidad, registro, pregunta frecuente, reserva) → recordatorio con la fecha y confirmación, sin duplicados → segundo aviso el mismo día → lista de espera (apuntarse, cancelación en el panel, oferta y reserva con un botón) → cambiar una cita por WhatsApp, nota de voz y foto → página pública de reservas hasta la cita en WhatsApp → calendario, enlace de agenda (solo iniciales), clientes, métricas, registro de actividad y consola de la plataforma → servidor del bot (`/health`, verificación de Meta, webhook firmado y sin firmar, jobs con y sin secreto, cabeceras).
- **Resultado:** todo funciona, sin errores de consola, de CSP ni respuestas 5xx en el panel.
- **Arreglado:**
  - El calendario oculta por defecto las citas canceladas: compartían hueco con la nueva cita de la misma hora y las dos quedaban apretadas. La casilla «Ver canceladas (N)» aparece si hay alguna en las fechas visibles.
  - El simulador (`/recordatorios`) cuenta también los segundos avisos del mismo día (F30).
- **Solo en desarrollo:** la IA simulada (`LLM_MODE=mock`) responde con reglas: «Hola, ¿qué horario tenéis?» se queda en un saludo y de una pregunta doble contesta una parte. Con OpenAI no pasa.

### Vídeo de demostración (16 de noviembre de 2026)

Al grabar el recorrido guiado aparecieron tres fallos del panel, ya arreglados:

- **Bonos:** el nombre por defecto («Bono N sesiones») deja de seguir al número de sesiones solo cuando se escribe el nombre a mano. Antes, si se vaciaba el campo «Sesiones» antes de escribir (por ejemplo, con la tecla de borrar), el nombre se quedaba en «Bono 10 sesiones».
- **Tratamientos:** el campo «Sesiones» vacío se queda vacío. Antes pasaba a 0, y al escribir 4 quedaba «04».
- **Calendario:** «Próximas citas» oculta las citas canceladas, igual que el calendario, salvo que se marque «Ver canceladas».

La prueba de extremo a extremo (`e2e/smoke.spec.ts`) cubre los tres casos: vacía los campos antes de escribir y comprueba que las sesiones canceladas de un tratamiento salen de «Próximas citas».

Al revisar el vídeo, el borde de los campos de formulario (textos, desplegables y selector de cliente) apenas se distinguía del fondo: `--input` era `#d4d4d8`, con un contraste de 1,5:1 sobre blanco. Ahora es `#8a8a93`: 3,4:1 sobre blanco y 3,1:1 sobre el gris claro (`--muted`), por encima del 3:1 que pide WCAG 2.1 (criterio 1.4.11, contraste de elementos no textuales). La revisión con axe del e2e no mide este contraste, así que lo comprueba `test/theme.test.ts`.

## Verificación final (F10)

Ejecutada el 10/11/2026 en local (Windows 11, Node 24.15, PostgreSQL 18 embebido), con `WHATSAPP_MODE=mock` y `LLM_MODE=mock` (no hay credenciales reales en este entorno).

### 1. Calidad
| Comprobación | Resultado |
|---|---|
| `pnpm lint` | ✅ sin errores ni avisos |
| `pnpm typecheck` | ✅ shared, db, bot y web |
| `pnpm test` | ✅ 12 ficheros, **191 tests en verde**, 29 omitidos (LLM real, `LLM_LIVE_TESTS=true`) |
| `pnpm build:web` | ✅ `next build` (Turbopack) sin errores ni avisos |
| `pnpm e2e` | ✅ 2/2 (Playwright, autenticación simulada) |

### 2. Recorrido completo con el simulador
Cliente nuevo → registro → FAQ → cita → profesional → confirmación (`pnpm bot:simulate --tenant fisiodemo --phone +34612345678`):

```text
👤 Hola
🤖 Bienvenido/a a FisioDemo. Soy su asistente virtual 🤖. Parece que es tu primera vez aquí.
🤖 ¿Quieres comenzar con el registro?
   [#1 Sí]  [#2 No, gracias]
👤 #1
🤖 Perfecto, voy a proceder con algunas preguntas
🤖 Por favor, escribe tu nombre completo:
👤 Lucía Fernández Gómez
🤖 ¿Cuál es tu email?
👤 lucia.fernandez@gmail.com
🤖 ✅ ¡Registro completado en FisioDemo, Lucía! Ahora puedes pedir tu cita.
👤 ¿Qué horario tenéis?
🤖 Nuestro horario es: lunes a viernes, de 7:00 a 20:00.
👤 Podría ser pasado mañana a las 12?
🤖 ✅ ¡Genial! La fecha jueves, 12 de noviembre de 2026, 12:00 está disponible en FisioDemo.
🤖 Estos son los profesionales disponibles en FisioDemo para esa hora. Selecciona uno o pulsa "Cancelar" para salir:
   [#1 Daniel]  [#2 Marcos]  [#3 Cancelar]
👤 #1
🤖 ✅ Has seleccionado a Daniel en FisioDemo.
   
   📅 Fecha: jueves, 12 de noviembre de 2026
   🕐 Hora: 12:00
   👤 Profesional: Daniel
🤖 ¿Deseas confirmar la cita, cambiar la fecha o salir?
   [#1 Sí ✅]  [#2 Otra fecha]  [#3 Salir]
👤 #1
🤖 ✅ ¡Cita confirmada en FisioDemo para jueves, 12 de noviembre de 2026, 12:00!
👤 /citas
   ⚙ jueves, 12 de noviembre de 2026, 12:00 · Daniel · Pendiente (pending) · whatsapp
```

Segunda sesión: se adelanta el reloj simulado un día y se lanza el recordatorio a mano:

```text
👤 /avanzar 1d
   ⚙ hora simulada: miércoles, 11 de noviembre de 2026, 17:02
👤 /recordatorios
   ⚙ recordatorios enviados: 1 · fallidos: 0
🤖 [plantilla recordatorio_cita] Hola Lucía, te recordamos tu cita en FisioDemo mañana a las 12:00.
   [#1 Sí, confirmo]  [#2 No puedo asistir]
👤 #1
🤖 ¡Gracias! Tu cita en FisioDemo ha sido confirmada ✅. ¡Nos vemos mañana!
👤 /citas
   ⚙ jueves, 12 de noviembre de 2026, 12:00 · Daniel · Confirmada (confirmed) · whatsapp
```

Estado en la BD consultado antes y después:

```text
ANTES  : [{"status":"pending","source":"whatsapp","reminder_sent_at":null}]
DESPUÉS: [{"status":"confirmed","source":"whatsapp","reminded":true}]
```

### 3. Casos negativos
Email inválido, fecha pasada, sin disponibilidad (con 3 huecos sugeridos), profesional inexistente, palabra de escape y 3 fallos seguidos (`--phone +34698765432`):

```text
👤 Hola
🤖 Bienvenido/a a FisioDemo. Soy su asistente virtual 🤖. Parece que es tu primera vez aquí.
🤖 ¿Quieres comenzar con el registro?
   [#1 Sí]  [#2 No, gracias]
👤 #1
🤖 Perfecto, voy a proceder con algunas preguntas
🤖 Por favor, escribe tu nombre completo:
👤 Marta Ruiz
🤖 ¿Cuál es tu email?
👤 marta@correo
🤖 Ese email no parece válido. Ejemplo: nombre@gmail.com. Inténtalo de nuevo:
👤 marta.ruiz@gmail.com
🤖 ✅ ¡Registro completado en FisioDemo, Marta! Ahora puedes pedir tu cita.
👤 Quiero cita hoy a las 7
🤖 Esa fecha ya ha pasado. Dime otra, por ejemplo "mañana a las 10"
👤 el martes a las 18
🤖 Lo siento, no hay disponibilidad para martes, 17 de noviembre de 2026, 18:00. ¿Te viene bien otro día u hora?
🤖 Estos son los huecos libres más cercanos. Pulsa uno o escríbeme otra fecha:
   [#1 mié 18 nov, 07:00]  [#2 mié 18 nov, 08:00]  [#3 mié 18 nov, 09:00]
👤 #1
🤖 ✅ ¡Genial! La fecha miércoles, 18 de noviembre de 2026, 07:00 está disponible en FisioDemo.
🤖 Estos son los profesionales disponibles en FisioDemo para esa hora. Selecciona uno o pulsa "Cancelar" para salir:
   [#1 Daniel]  [#2 Marcos]  [#3 Cancelar]
👤 Pepe
🤖 No he encontrado a ese profesional. Elige uno de la lista, por favor:
🤖 Estos son los profesionales disponibles en FisioDemo para esa hora. Selecciona uno o pulsa "Cancelar" para salir:
   [#1 Daniel]  [#2 Marcos]  [#3 Cancelar]
👤 cancelar
🤖 Has cancelado la reserva. ¡Aquí estaré si me necesitas!
👤 Quiero cita
🤖 ¡Hola Marta! Bienvenido/a de nuevo a FisioDemo 👋
   Soy el asistente virtual 🤖 de FisioDemo.
🤖 Por favor, indícame la fecha para tu cita en FisioDemo (Ej: "15 de marzo a las 10")
👤 asdf
🤖 No he entendido la fecha 🤔. Indícame día y hora, por ejemplo "mañana a las 10" o "15 de marzo a las 17:30".
👤 qwerty
🤖 No he entendido la fecha 🤔. Indícame día y hora, por ejemplo "mañana a las 10" o "15 de marzo a las 17:30".
👤 zzz
🤖 No consigo entenderte bien 😅. Para continuar, llama a FisioDemo al 965 000 000.
```

Número en lista negra (fila insertada en `bot_blacklist`): el bot no responde.

```text
👤 Hola, ¿hay alguien?
👤 /estado
   ⚙ estado: sin conversación activa
```

Webhook de Meta por HTTP contra el bot arrancado (`META_APP_SECRET` configurado):

```text
GET  verificación correcta  → 200, cuerpo = hub.challenge (4242)
GET  verify_token erróneo   → 403
POST firma inválida         → 401 (no se procesa)
POST firma válida           → 200 → "incoming whatsapp message" (1 vez)
POST mismo mensaje repetido → 200 → "duplicate webhook message: ignored"
```

Todos estos casos están cubiertos también por tests automáticos (`conversation.test.ts`, `webhook.test.ts`, `chatwoot.test.ts`).

### 4. Sincronización web
Con `/calendar` abierto en un navegador (Playwright, sin recargar la página), el simulador registró a la clienta y reservó la cita del jueves 12 a las 12:00. La cita apareció en el panel «Próximas citas» y en la rejilla del mes **13,75 s** después de confirmarse (objetivo ≤ 15 s), con el badge «Pendiente» y el color de Daniel (el mismo de la leyenda):

```json
{"reloads":0,"elapsedMs":13750,"pending":true,"eventVisible":true,"itemText":"Lucía Fernández Gómez con Daniel jueves, 12 de noviembre de 2026, 12:00 Pendiente"}
```

### 5. Aislamiento entre tenants
- Web: `apps/web/test/routers.test.ts` › *a user of tenant 2 cannot read or modify data of tenant 1* (lectura, edición, borrado y creación cruzada).
- Bot y BD: `services.test.ts` › *repositories are tenant-scoped*, *the database itself rejects cross-tenant links (composite FKs)*; `conversation.test.ts` › *isolates clients per tenant*; `reminders.test.ts` › *cannot confirm an appointment of another phone or tenant*.

### 6. Trazabilidad
[`TRACEABILITY.md`](TRACEABILITY.md): RF-W1…W5, RF-A1…A4, CU-C1…C9 y CU-A1…A14 (nombres de la especificación funcional) con su implementación y su prueba o evidencia.

### 7. Secretos
Solo están versionados los `.env.example`. La búsqueda de patrones de claves (OpenAI `sk-…`, tokens de Meta `EAA…`, claves privadas y URLs de Supabase) en los ficheros versionados no encuentra nada. La `ENCRYPTION_KEY` de tests y CI es un valor ficticio (`AAAA…=`).

## Limitaciones conocidas y pendientes

- **Integraciones reales sin probar** por falta de credenciales en este entorno: Meta (envío real y plantilla aprobada), Kinde (login OTP real), OpenAI/DeepSeek (las 29 pruebas de fechas con `LLM_LIVE_TESTS=true` y las métricas de `eval/`), Chatwoot, Supabase, Railway y Netlify. Todas tienen implementación real, mocks y tests con *fakes*; la guía de puesta en marcha está en `docs/deploy.md`.
- **`gpt-4o-mini` se retira el 14/01/2027**: hay que cambiar `OPENAI_MODEL` (OpenAI anuncia `gpt-6-luna`). Antes, compáralo con el workflow «Evaluación IA» lanzado a mano con ese modelo (F22).
- **Comprobación previa:**
  - No se ha probado contra Meta, OpenAI ni Kinde reales (no hay credenciales): las respuestas se simulan con el formato de su documentación.
  - DeepSeek no se comprueba.
  - Si una clínica usa su propia cuenta de WhatsApp Business, sus plantillas no se revisan, porque solo se comprueba la cuenta de `META_WABA_ID`.
- **Aislamiento en la base de datos:**
  - La contraseña de `clinicai_app` se pone a mano en Supabase.
  - No se ha probado contra un proyecto real de Supabase (no hay credenciales en este entorno); sí contra PostgreSQL 18 local y en los tests.
- **Equipo:**
  - No se envían correos de invitación: el administrador avisa a la persona.
  - Un administrador no puede tener también su propia agenda de profesional.
- **Agenda en el móvil:**
  - No es instantánea: cada app refresca la suscripción a su ritmo (Google, cada varias horas).
  - No hay agenda de toda la clínica, solo por profesional.
  - Un administrador sin agenda propia no tiene enlace para sí.
- **Página de reservas:**
  - Sin límite de peticiones (como el resto de páginas públicas).
  - No se puede incrustar en otra web (solo enlace y botón).
  - Las reservas que llegan desde la página no se distinguen en las métricas de las demás de WhatsApp.
- **Tratamientos y bonos:**
  - Un tratamiento no se puede mover entero: cada sesión se cambia por separado.
  - El bot no crea tratamientos, solo citas sueltas.
  - Los bonos no tienen precio ni cobro (irán con los pagos).
  - No se avisa al cliente por WhatsApp cuando le queda poco bono.
- **Seguridad del panel:**
  - La política permite estilos en línea (`'unsafe-inline'`), que necesitan los componentes.
  - Las comprobaciones de accesibilidad son automáticas (axe): no sustituyen a una prueba con lector de pantalla y teclado.
  - `/api/csp-report` no tiene límite de peticiones (solo de tamaño).
- **Registro de actividad:** no registra los mensajes que envía el bot (recordatorios, avisos de la lista de espera) ni lo que hacen los agentes en Chatwoot. El plazo de 2 años es fijo.
- **Lista de espera:**
  - La plantilla `aviso_hueco_libre` no se ha enviado a revisión de Meta (no hay credenciales en este entorno).
- **Transcripción real sin probar:** las notas de voz se han probado con el cliente de OpenAI simulado (petición *multipart* comprobada en tests) y con audios simulados. Falta probar `gpt-transcribe` con notas de voz reales de WhatsApp y acentos variados.
- **Sin verificar en documentación oficial** (dominios inaccesibles para la herramienta de lectura): los modelos y endpoints actuales de DeepSeek y el formato exacto de algunas respuestas de la API de Chatwoot. Ambos son configurables o tolerantes a variantes.
- **Imagen Docker no construida** (no hay Docker en esta máquina): se reprodujeron sus pasos en una carpeta temporal, con instalación, `prisma generate` y arranque correctos.
- **Tiempo real por *polling*** (15 s). Supabase Realtime queda como mejora opcional.
- En Windows, Vitest puede avisar al final de que «algo impide cerrar» por el PostgreSQL embebido; el código de salida es 0.
