# Guía de despliegue

Arquitectura del MVP: **bot** en Railway, **panel web** en Netlify y **base de datos** en Supabase (PostgreSQL). Todos los servicios tienen capa gratuita.

```
Meta (WhatsApp Cloud API) ──► Railway: apps/bot ──┐
                                                  ├──► Supabase (PostgreSQL)
Navegador ──► Netlify: apps/web (Kinde) ──────────┘
Chatwoot (opcional) ◄──► Railway: apps/bot
```

## 0. Orden y comprobación previa

Sigue los pasos en este orden: **1** Supabase → **2** Railway → **3** Meta → **4** Kinde → **5** Netlify → **6** Chatwoot (opcional) → **7** lista final. Al final de cada paso, ejecuta la comprobación previa (F20). Lee la configuración y pregunta a cada servicio si está listo, sin escribir nada ni enviar ningún mensaje:

```bash
# Con las variables de producción en apps/bot/.env (o, con la CLI de Railway: railway run pnpm preflight)
pnpm preflight --web-env apps/web/.env.local --bot-url https://<bot> --web-url https://<web>
```

| Área | Qué comprueba |
|---|---|
| Base de datos | Conexión, zona horaria UTC, migraciones al día y el rol `clinicai_app` con RLS (F19) |
| WhatsApp | Que el número de cada clínica esté `CONNECTED` y su calidad. Con `META_WABA_ID`, también que las plantillas estén aprobadas y la app suscrita al webhook (con `META_APP_ID`, que sea esta app) |
| IA | Que la clave de OpenAI sea válida, que los modelos estén disponibles y su fecha de apagado anunciada |
| Panel | Misma `ENCRYPTION_KEY` que el bot, URLs de Kinde coherentes y dominio de Kinde accesible |
| Chatwoot | Que exista la bandeja (`CHATWOOT_INBOX_NAME`) |
| Despliegue | `/health` del bot y del panel, y que el `VERIFY_TOKEN` coincida con el del bot desplegado |

Cada línea sale como ✅, ⚠️, ❌ o ⏭️ (sin datos para comprobarla). Si hay algún ❌, el comando termina con código 1. Las opciones son independientes: sin `--bot-url` no se comprueba el bot desplegado, y así con las demás.

## 1. Supabase (base de datos)

1. Crea un proyecto en [supabase.com](https://supabase.com). Elige la región de la UE más cercana (p. ej. Fráncfort).
2. **Project Settings → Database → Connection string**:
   - `DATABASE_URL`: cadena **pooled** (Supavisor/pgbouncer, puerto `6543`), añadiendo `?pgbouncer=true`. Es la que usan la app y el bot.
   - `DIRECT_URL`: cadena **directa** (puerto `5432`). Solo la usan las migraciones.
3. Aplica las migraciones desde tu máquina:
   ```bash
   cd packages/db
   DIRECT_URL="postgresql://…:5432/postgres" pnpm migrate:deploy
   ```
   La migración `enable_rls` activa RLS en todas las tablas y deniega el acceso a los roles `anon` y `authenticated` de la API REST de Supabase. La migración `tenant_isolation` crea el rol `clinicai_app`, con el que trabajan la app y el bot: PostgreSQL solo le deja ver y cambiar las filas de la clínica de cada petición (F19).
4. Activa el rol de la aplicación (F19). La migración lo crea sin contraseña, para que no haya secretos en el repositorio:
   1. En el editor SQL de Supabase, ejecuta `ALTER ROLE clinicai_app WITH LOGIN PASSWORD '<contraseña larga y aleatoria>';`. Supabase recomienda al menos 12 caracteres; si lleva símbolos, codifícalos en la URL (p. ej. `=` → `%3D`).
   2. `DATABASE_APP_URL`: la misma cadena **pooled** que `DATABASE_URL` (puerto `6543`, `?pgbouncer=true`), pero con el usuario `clinicai_app.<project-ref>` y esa contraseña. Es el formato que indica Supabase para los roles propios en el *pooler*.
   3. Ponla en Railway y en Netlify. `DATABASE_URL` (rol `postgres`) sigue haciendo falta para lo que abarca varias clínicas: la cola de mensajes, saber de qué clínica es un número, los trabajos programados y el alta de clínicas.
   4. En producción (`NODE_ENV=production`), el bot y el panel **no arrancan** sin `DATABASE_APP_URL` (F32): sin ella solo el código separaría las clínicas. Si de verdad quieres funcionar así, define `ALLOW_OWNER_CONNECTION=true` (`pnpm preflight` lo avisa).
5. Opcional, para una demo: `pnpm db:seed` (con `DATABASE_URL` y `DIRECT_URL` apuntando a Supabase) crea FisioDemo y una segunda clínica de prueba.
6. La base de datos tiene que usar **UTC**: compruébalo con `SHOW timezone;` en el editor SQL y, si no lo es, ejecuta `ALTER DATABASE postgres SET timezone TO 'UTC';`. El adaptador de Prisma envía y lee las fechas sin desfase, así que con otra zona las horas quedarían desplazadas. Si no es UTC, el bot lo avisa en el registro al arrancar.

**Comprueba:** `pnpm preflight` (con `DATABASE_URL` y `DATABASE_APP_URL` de Supabase) → «Zona horaria» ✅, «Migraciones» ✅ y «Aislamiento por clínica» ✅.

## 2. Railway (bot de WhatsApp)

1. **New Project → Deploy from GitHub repo** y elige este repositorio.
2. En el servicio:
   - **Root Directory**: vacío (la raíz del repo; la imagen necesita `packages/`).
   - **Pre-deploy command**: `pnpm --filter @clinicai/db migrate:deploy`. Aplica las migraciones antes de cada versión; si fallan, Railway no despliega.
   - **Imagen (F33):** el Dockerfile fija Node por versión y *digest* (`FROM node:24.22.3-slim@sha256:…`), así que no recibe solo los parches de Node. Revísalo una vez al mes: busca la última `24.x.y-slim` en Docker Hub (o `docker buildx imagetools inspect node:24-slim`) y cambia versión y *digest* juntos. El CI construye la imagen en cada cambio.
   - **Healthcheck path**: `/health`. Sin credenciales solo responde si está vivo y si hay base de datos; los modos y la cola se ven enviando la cabecera `x-cron-secret` (`pnpm preflight` lo hace) (F34).
   - **Watch paths** (opcional, para no reconstruir el bot por cambios del panel): `apps/bot/**`, `packages/**` y `pnpm-lock.yaml`.
   - Railway ya no admite el fichero de configuración (`railway.json`) en servicios nuevos, y deja de leerlo en los existentes el **01/12/2026**. Por eso todo se configura en el servicio. Su sustituto, *Infrastructure as Code* (`.railway/railway.ts` con la CLI de Railway), no documenta la ruta del Dockerfile ni el tiempo de cierre, que van en variables.
3. **Variables**: todas las de `apps/bot/.env.example`. Como mínimo:
   - `RAILWAY_DOCKERFILE_PATH=apps/bot/Dockerfile`: es la forma documentada de usar un Dockerfile que no está en la raíz. En el registro de la primera compilación, comprueba que usa ese fichero.
   - `DATABASE_URL`, `DIRECT_URL` y `DATABASE_APP_URL` (paso 1.4)
   - `WHATSAPP_MODE=live`, `META_GRAPH_VERSION=v27.0`, `META_JWT_TOKEN`, `META_APP_SECRET`, `VERIFY_TOKEN`
   - `LLM_MODE=live`, `AI_PROVIDER=openai`, `OPENAI_API_KEY`, `OPENAI_MODEL`. Opcionalmente, IA de respaldo con otro modelo de OpenAI: `ENABLE_FALLBACK=true` + `OPENAI_FALLBACK_MODEL`. DeepSeek solo con `FALLBACK_PROVIDER=deepseek` + `DEEPSEEK_API_KEY`, y antes lee [`rgpd.md`](rgpd.md): supone una transferencia internacional de datos.
   - Residencia de datos en la UE (opcional, requiere aprobación de OpenAI): `OPENAI_BASE_URL=https://eu.api.openai.com/v1` con un proyecto creado en la región Europa. Detalles en [`rgpd.md`](rgpd.md).
   - `ENCRYPTION_KEY` (la misma que en Netlify), `CRON_SECRET`
   - `NODE_ENV=production`. Railway inyecta `PORT`.
   - `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=60`: segundos entre el `SIGTERM` y el `SIGKILL` de la versión anterior en cada despliegue. Railway lo pone a 0 por defecto, y entonces el bot no tiene tiempo de terminar los mensajes que está procesando. Si alguno queda a medias, otra instancia lo retoma unos 30 s después, pero el cliente nota el retraso.
4. **Networking → Generate Domain**: obtendrás `https://<servicio>.up.railway.app`.
5. Varias réplicas: es seguro escalar horizontalmente. El estado de las conversaciones y la cola de mensajes entrantes (`inbound_events`) están en la BD. Cada conversación se procesa en orden y en una sola instancia a la vez, y el límite de mensajes por minuto se cuenta en la BD. El cron de recordatorios usa *advisory locks* y `reminder_sent_at`. El cron interno se ejecuta cada 15 minutos (`REMINDER_CRON`): cada clínica envía a su hora y nunca entre las 21:00 y las 8:00. Si prefieres un cron externo, pon `ENABLE_CRON=false` y programa `POST /jobs/reminders/run` cada 15 minutos con la cabecera `x-cron-secret` y el cuerpo `{"force": false}`. Sin ese cuerpo, la llamada ignora la hora de cada clínica: sirve para lanzarlo a mano.

> Si tu servicio se creó con el antiguo `apps/bot/railway.json`, vacía el campo *Config file path* del servicio y pon los valores de arriba antes del 01/12/2026.

**Comprueba:** `pnpm preflight --bot-url https://<servicio>.up.railway.app` → «Bot /health» ✅, «Bot: cabeceras de seguridad» ✅ y «Verificación del webhook» ✅.

> Notas de voz: se transcriben con OpenAI (`OPENAI_TRANSCRIBE_MODEL`, por defecto `gpt-transcribe`), así que necesitan `OPENAI_API_KEY` aunque la IA principal sea DeepSeek. `VOICE_MAX_SECONDS` limita la duración (120 s por defecto) y `VOICE_NOTES=false` las desactiva. No cambies a `whisper-1`, `gpt-4o-transcribe` ni `gpt-4o-mini-transcribe`: OpenAI los apaga el **26/02/2027**.

> ⚠️ `gpt-4o-mini` deja de estar disponible en la API de OpenAI el **14/01/2027**. Cambia `OPENAI_MODEL` antes de esa fecha (OpenAI anuncia `gpt-6-luna` como sustituto). Si el nuevo modelo no admite `temperature`, el cliente reintenta automáticamente sin ella.
> Antes de cambiarlo, evalúa el candidato en GitHub: *Actions → Evaluación IA → Run workflow*, con ese modelo. Si los dos objetivos salen en verde, cámbialo en Railway y también en la variable del repositorio `OPENAI_MODEL`, para que las siguientes evaluaciones usen el mismo modelo que producción (`eval/README.md`).

## 3. Meta for Developers (WhatsApp Cloud API)

1. [developers.facebook.com](https://developers.facebook.com) → **Create App** (tipo *Business*) → añade el producto **WhatsApp**.
2. **WhatsApp → API Setup**: copia el **Phone number ID** (va a `tenant_config.wa_phone_number_id`; se configura en el panel, en *Ajustes → WhatsApp*) y genera un token permanente con un *System User* (`META_JWT_TOKEN`, o el token propio de cada clínica en Ajustes, que se guarda cifrado).
   - **F32:** al guardar un *Phone number ID* con token propio, el panel comprueba con Meta que ese token llega al número y que es el «Número de WhatsApp del negocio». Sin token propio (se usa `META_JWT_TOKEN`), solo un administrador de la plataforma (`PLATFORM_ADMIN_EMAILS`) puede asignar el número a una clínica.
3. **App Settings → Basic → App Secret** → `META_APP_SECRET`. En esa misma página está el **App ID** → `META_APP_ID` (solo para la comprobación previa).
4. **WhatsApp → Configuration → Webhook**:
   - Callback URL: `https://<bot>/webhook`
   - Verify token: el valor de `VERIFY_TOKEN`
   - Suscríbete al campo **messages**.
5. Crea la plantilla del recordatorio y mándala a revisión: [`docs/meta-template.md`](meta-template.md). Si la clínica va a usar la lista de espera, crea también `aviso_hueco_libre` y, cuando esté aprobada, actívala en **Ajustes → Lista de espera**.
6. Copia el identificador de la cuenta de WhatsApp Business (**WABA ID**, en WhatsApp Manager) → `META_WABA_ID`. El bot no lo necesita para funcionar, pero sin él la comprobación previa no puede revisar las plantillas ni la suscripción del webhook (no se puede deducir del número).

**Comprueba:** `pnpm preflight` → el número de cada clínica ✅ (`CONNECTED`), las plantillas ✅ (o ⚠️ mientras Meta las revisa) y «Webhook suscrito» ✅.

### Probar en local con ngrok

```bash
pnpm db:local                      # terminal 1
pnpm dev:bot                       # terminal 2 (apps/bot/.env con WHATSAPP_MODE=live)
ngrok http 3008                    # terminal 3
```

Registra `https://<id>.ngrok-free.app/webhook` como Callback URL en Meta. Escribe al número de prueba desde un teléfono autorizado en *API Setup → To*. El `phone_number_id` de ese número debe estar en el tenant: en el seed, la variable `NUMBER_ID` lo asigna a FisioDemo.

## 4. Kinde (login del panel)

1. Crea una aplicación **Back-end web** en [kinde.com](https://kinde.com) y elige Next.js.
2. **Allowed callback URLs**: `https://<web>/api/auth/kinde_callback` (y `http://localhost:3000/api/auth/kinde_callback` para local).
3. **Allowed logout redirect URLs**: `https://<web>` (y `http://localhost:3000`).
4. Acceso sin contraseña con código de un solo uso: **Settings → Environment → Authentication → Passwordless → "Email connections › Code" → Configure**. Actívalo para la aplicación y desactiva las contraseñas si quieres solo OTP.
5. Variables (`apps/web/.env.example`): `KINDE_CLIENT_ID`, `KINDE_CLIENT_SECRET`, `KINDE_ISSUER_URL`, `KINDE_SITE_URL`, `KINDE_POST_LOGIN_REDIRECT_URL` (`…/dashboard`), `KINDE_POST_LOGOUT_REDIRECT_URL`.
6. El primer acceso de un usuario lleva a **/onboarding** («Crea tu clínica»), que crea su `tenant_config` y le asigna el rol `owner`. Para dar acceso a un usuario de Kinde a una clínica que ya existe (p. ej. FisioDemo del seed), usa `SEED_KINDE_USER_ID=kp_… pnpm db:seed` o inserta una fila en `tenant_members`.
7. Equipo (F18): el resto de usuarios se invitan desde **Ajustes → Equipo** y entran con el email invitado. Kinde tiene que permitir que se registren usuarios nuevos (registro autónomo, *self sign-up*). Si lo tienes desactivado, crea antes a cada persona en Kinde con ese mismo email. Kinde verifica el email con el código, y la invitación solo se usa con el email de la sesión.

## 5. Netlify (panel web)

1. **Add new site → Import from Git** → este repositorio. **Base directory**: vacío (la raíz). El `netlify.toml` de la raíz define el comando (`pnpm build:web`), el directorio `apps/web/.next` y el plugin `@netlify/plugin-nextjs`, cuya versión fija el `package.json` de la raíz (y el fichero de bloqueo, F34).
2. **Environment variables**: `DATABASE_URL` y `DATABASE_APP_URL` (pooled, paso 1.4), las de Kinde (con la URL de Netlify), `ENCRYPTION_KEY` y, opcionalmente, `NEXT_PUBLIC_CHATWOOT_URL`. `KINDE_SITE_URL` es también la dirección pública de las páginas de reservas (F27), de su código QR y de los enlaces de agenda (F28): si el panel tiene dominio propio, pon ese. Los enlaces de agenda se cifran con `ENCRYPTION_KEY`: si cambia, hay que crearlos de nuevo.
   - **WhatsApp en el panel (F32):** no pongas `WHATSAPP_MODE=mock` en Netlify: con él, el panel no comprueba con Meta los números que guardan las clínicas. `META_GRAPH_VERSION` es opcional (por defecto `v27.0`, la misma que el bot).
   - **Consola de la plataforma (F31):** `PLATFORM_ADMIN_EMAILS` con los emails (los de Kinde) de quien gestiona el servicio, separados por comas. Solo ellos ven `/plataforma`. Opcional: `PLATFORM_PRICES` (JSON) para cambiar los precios de la estimación de costes (ver `apps/web/.env.example`).
3. **Nunca** definas `AUTH_MOCK_USER` ni `ALLOW_AUTH_MOCK` en Netlify: solo existen para los tests e2e. Aunque se pusieran por error, el panel no se salta el inicio de sesión si su dirección (`KINDE_SITE_URL`) no es `localhost` (F34).
4. Comprobación: `https://<web>/api/health` → `{"status":"ok"}`.
5. **Seguridad (F25):** el panel envía una política de seguridad de contenido (CSP) estricta y HSTS, y el bot sus propias cabeceras. Sirve los dos solo por HTTPS (Netlify y Railway lo hacen).
   - Las infracciones de la política aparecen en los registros de las funciones de Netlify como `csp violation`.
   - **Vía de escape:** si algo deja de funcionar en el panel por la política (por ejemplo, tras un cambio de Kinde), define `CSP_REPORT_ONLY=true` y vuelve a desplegar. El navegador deja de bloquear y solo informa. Quítala cuando esté corregido; `pnpm preflight` avisa mientras siga puesta.

**Comprueba:** `pnpm preflight --web-env <fichero con las variables de Netlify> --web-url https://<web>` → «ENCRYPTION_KEY» ✅, «Kinde» ✅, «Panel /api/health» ✅ y «Panel: cabeceras de seguridad» ✅.

## 6. Chatwoot (opcional: atención humana)

1. En Chatwoot (cloud o autoalojado): **Settings → Inboxes → Add Inbox → API**. Ponle un nombre (p. ej. `WhatsApp ClinicAI`) y no indiques webhook en la bandeja.
2. **Profile Settings → Access Token** → `CHATWOOT_TOKEN`. El ID de la cuenta está en la URL (`/app/accounts/<id>/…`) → `CHATWOOT_ACCOUNT_ID`.
3. **Settings → Integrations → Webhooks → Add**:
   - Evento: **Message created**.
   - **Mejor con firma:** si tu versión de Chatwoot permite definir un *secret*, pon el mismo valor que `CHATWOOT_WEBHOOK_SECRET` y usa la URL sin token: `https://<bot>/chatwoot/webhook`. El bot valida `X-Chatwoot-Signature` (HMAC-SHA256 de `"<timestamp>.<body>"`) y rechaza las firmas de hace más de 5 minutos, así que un mensaje capturado no se puede repetir (F34).
   - **Si no admite firma:** `https://<bot>/chatwoot/webhook?token=<CHATWOOT_WEBHOOK_SECRET>`. Funciona igual, pero el secreto viaja en la URL y puede quedar en los registros de los proxies: cámbialo si los compartes.
4. Variables del bot: `CHATWOOT_URL`, `CHATWOOT_ACCOUNT_ID`, `CHATWOOT_TOKEN`, `CHATWOOT_INBOX_NAME`, `CHATWOOT_WEBHOOK_SECRET`. Una clínica puede usar otra cuenta o bandeja con `settings.chatwoot = { accountId, inboxId, baseUrl }`.
5. Uso: cada conversación de WhatsApp aparece en la bandeja. En una conversación, una **nota privada** `/bot off` pausa el bot para ese contacto, `/bot on` lo reactiva y `/bot status` muestra el estado. Los mensajes normales del agente se envían al cliente por WhatsApp (solo dentro de la ventana de 24 h).

### Límite de peticiones en las páginas públicas (F34)

La página de reservas (`/reservar/<dirección>`), los enlaces de agenda (`/api/calendar/…`) y los informes de la política de seguridad (`/api/csp-report`) no necesitan sesión. El código no limita cuántas peticiones recibe cada uno: en Netlify cada petición puede ir a una función distinta, sin memoria compartida, así que un límite en el código no serviría. Si los ves abusados (picos en los registros de Netlify), añade una regla de límite de peticiones en Netlify (si tu plan lo incluye) o pon delante un CDN con esa opción (por ejemplo, Cloudflare). Los enlaces de agenda no se pueden adivinar (256 bits).

## 7. Lista de comprobación tras desplegar

- [ ] `pnpm preflight --web-env … --bot-url https://<bot> --web-url https://<web>` → **0 errores**. Revisa también los avisos: modo simulado, modelos que se apagan pronto o plantillas en revisión.

- [ ] `GET https://<bot>/health` → `{"status":"ok","db":"up",…,"queue":{"pending":0,"processing":0,"failedLast24h":0,"lagSeconds":0}}`. Vigila `queue`: si `lagSeconds` crece, los mensajes se procesan más despacio de lo que llegan; si `failedLast24h` es mayor que 0, hay eventos fallidos en la tabla `inbound_events` (`status = 'failed'`, columna `last_error`).
- [ ] Verificación del webhook en Meta en verde.
- [ ] Mensaje real al número → respuesta del bot (registro o saludo).
- [ ] Cita creada por WhatsApp visible en el calendario web en ≤ 15 s.
- [ ] Plantilla `recordatorio_cita` aprobada con el texto que lleva la fecha (cuatro variables) y `POST /jobs/reminders/run` con `x-cron-secret` → `sent ≥ 1` si hay citas para mañana.
- [ ] (Lista de espera) plantilla `aviso_hueco_libre` aprobada antes de activarla en Ajustes; `POST /jobs/waitlist/run` con `x-cron-secret` responde `{"tenants":…,"offered":…,"failed":0}`.
- [ ] (Chatwoot) mensajes replicados y `/bot off` → el bot deja de responder.
- [ ] Protección de datos: URL de la política de privacidad en **Ajustes → Protección de datos**, plazo de conservación elegido y los pasos de [`rgpd.md`](rgpd.md#qué-tiene-que-hacer-la-clínica) revisados con el asesor de la clínica.
