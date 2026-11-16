# Protección de datos (RGPD)

Esta guía explica qué datos personales trata ClinicAI, qué hace la aplicación para cumplir el RGPD y qué tiene que hacer cada clínica antes de usarla con pacientes reales.

> **No es asesoramiento jurídico.** Los datos de una clínica de fisioterapia pueden incluir datos de salud, que el RGPD protege de forma especial (art. 9). Revisa esta guía con tu asesor o con tu delegado de protección de datos (DPD).

## Quién es quién

- **Responsable del tratamiento:** cada clínica. Decide para qué se usan los datos de sus pacientes.
- **Encargado del tratamiento:** quien presta el servicio ClinicAI a la clínica.
- **Subencargados:** los proveedores técnicos de la tabla de más abajo.

## Qué datos se guardan

| Dato | Dónde | Cuánto tiempo |
|---|---|---|
| Nombre, teléfono, email y notas del cliente | Base de datos (`clients`) | Hasta que la clínica lo borra, o hasta que lo anonimiza la política de conservación |
| Aceptación del aviso de privacidad: fecha, canal (WhatsApp o panel) y versión del texto | `clients` | Igual que el cliente |
| Citas: fecha, profesional, servicio, estado, asistencia y notas | `appointments` | Igual que el cliente. Al anonimizarlo se conservan las citas, sin nombre ni notas |
| Mensajes de WhatsApp recibidos | Cola `inbound_events` | El contenido se borra en cuanto se procesa. El registro sin contenido se guarda 7 días para descartar los reenvíos de Meta. Los mensajes que no se pudieron procesar conservan el contenido 30 días, para revisarlos. De una nota de voz solo se guarda su identificador en Meta, nunca el audio |
| Notas de voz | En ningún sitio | El audio se descarga de Meta, se envía a OpenAI para pasarlo a texto y se descarta. Solo queda el texto, que se trata como un mensaje escrito |
| Estado de la conversación con el bot | `conversation_state` | 30 minutos desde el último mensaje. Si alguien escribe desde la página de reservas sin haber aceptado aún el aviso, solo se guarda el código del hueco elegido (fecha, hora y servicio), para seguir tras aceptar |
| Bonos: nombre, sesiones, servicio, caducidad y qué citas gastaron cada sesión | `client_packs` y `appointments.pack_id` | Igual que el cliente: se exportan con él y se borran al suprimirlo. Al anonimizarlo se conservan (no tienen datos personales) |
| Lista de espera: día u hora que espera el cliente, servicio y avisos enviados | `waitlist_entries` | Hasta que reserva, se da de baja o pasa el día; se borra 30 días después. Se exporta con el cliente y se borra al suprimirlo o anonimizarlo |
| Pausa del bot para un contacto (`/bot off`) | `bot_blacklist` | Hasta `/bot on` o hasta que se borre el cliente |
| Copia de las conversaciones (opcional) | Chatwoot | La gestiona Chatwoot. Al borrar un cliente, se borra su contacto |
| Enlaces de la agenda de cada profesional (F28) | `calendar_feeds`: huella del enlace, enlace cifrado y fecha del último uso | Hasta que se revoca, se crea uno nuevo o la persona sale del equipo. La agenda que se ve por el enlace tiene las iniciales del cliente (o el nombre, si la clínica lo elige), el servicio y la hora; nunca teléfono, email ni notas. Esos datos pasan al calendario que elija el profesional (Google, Apple, Microsoft) |
| Email de los usuarios del panel | Kinde, `tenant_members` y, mientras no entran, `tenant_invitations` | Mientras tengan acceso. Al quitar a alguien del equipo (o cancelar su invitación) se borra de la aplicación; su cuenta de Kinde se borra en el panel de Kinde. Su email sigue 2 años en el registro de actividad, junto a lo que hizo |
| Registro de actividad: cuándo, quién (email del personal, «WhatsApp» o «Sistema»), la acción y los identificadores de la cita, del cliente o del profesional, sin nombres, teléfonos, emails de clientes ni notas | `activity_log` | 2 años. Al borrar o anonimizar a un cliente se quita el enlace a él y la entrada queda. Se exporta con el cliente |
| Uso de cada clínica (F31): por día, cuántos mensajes, peticiones y tokens de IA y segundos de notas de voz. Solo números, sin datos de clientes | `usage_daily` | 2 años. Solo lo ven los administradores de la plataforma, en su consola, junto al email del propietario de cada clínica |

Los registros técnicos (*logs*) nunca muestran teléfonos ni emails completos.

> **Lo que dice el asistente:** la clínica escribe la información que usa el asistente (Ajustes → Información para el asistente, o un texto propio) y responde de ella como de cualquier otra comunicación con sus pacientes. Antes de enviar cada respuesta, el bot comprueba que no lleve enlaces, emails ni teléfonos que no estén en ese texto ni diga que ha reservado nada (F32).

> **Notas:** no escribas en las notas del cliente ni de la cita más información de salud de la necesaria. Esas notas también aparecen en la exportación de datos. Lo mismo vale para el motivo de las ausencias del personal (por ejemplo, basta con «Baja», sin diagnóstico).

## Qué hace la aplicación

| Obligación | Cómo se cumple |
|---|---|
| **Página de reservas** | La página pública de la clínica no guarda ningún dato ni usa cookies: muestra huecos libres sin nombres de profesionales ni de clientes y abre WhatsApp con la cita escrita. El aviso de privacidad llega en el chat, como siempre. |
| **Informar antes de recoger datos** (art. 13) | Antes de pedir ningún dato, el bot muestra un aviso con el responsable, la finalidad, el uso de inteligencia artificial y los derechos del cliente. Incluye un enlace a la política de privacidad si está configurada en **Ajustes → Protección de datos**. El cliente pulsa «Acepto» o «No acepto». Si no acepta, no se guarda nada. |
| **Importación de clientes** | Al importar desde un CSV (F23), la clínica declara con una casilla si esos clientes ya aceptaron su política de privacidad. Si no, el bot les pide aceptar el aviso en su primer mensaje, como al resto. |
| **Guardar la aceptación** | Se registran la fecha, el canal y la versión del aviso (`PRIVACY_NOTICE_VERSION`). Los clientes dados de alta en el panel tienen una casilla para indicar que ya la aceptaron, por ejemplo en un formulario firmado. Si no está marcada, el bot les muestra el aviso en su primer mensaje y no procesa nada más, ni siquiera con la IA, hasta que aceptan. |
| **Acceso y portabilidad** (arts. 15 y 20) | En la ficha del cliente, **Exportar datos (JSON)** descarga todo lo que la aplicación guarda sobre él. |
| **Rectificación** (art. 16) | Editar la ficha del cliente. Quitar la casilla de aceptación la retira, y el bot vuelve a pedirla. |
| **Supresión** (art. 17) | **Eliminar** a un cliente borra en una sola operación su ficha, sus citas, sus bonos, su conversación con el bot, la pausa y los mensajes pendientes. Después el bot borra su contacto en Chatwoot, junto con sus conversaciones. |
| **Conservación limitada** (art. 5.1.e) | **Ajustes → Conservación de datos** (desactivado por defecto): anonimiza a los clientes sin citas en los últimos 1, 2, 3 o 5 años. Se ejecuta cada 6 horas. |
| **Notas de voz** | Solo se transcriben las de clientes que ya aceptaron el aviso, que lo menciona: «también las notas de voz (que se transcriben a texto y no se guardan)». El bot repite lo que ha entendido, para que el cliente pueda corregirlo. Los registros técnicos guardan la duración y el número de caracteres, nunca el texto. La voz no se usa para identificar a nadie. Se desactivan con `VOICE_NOTES=false`. |
| **Minimización** | El modelo de IA solo recibe el texto del mensaje (como máximo 1000 caracteres), el prompt de la clínica, el sector y la fecha y hora. Nunca recibe el nombre, el teléfono ni el email del cliente; un test lo comprueba. |
| **Acceso mínimo del personal** | Cada profesional del panel solo ve sus propias citas y, para reservar, el nombre y el teléfono de los clientes. Las fichas, la exportación y el borrado de datos quedan para el propietario y los administradores. |
| **Responsabilidad proactiva** (art. 5.2) | **Registro de actividad** (menú de la cuenta, solo propietario y administradores): quién consultó, exportó, cambió o borró datos y cuándo, y lo que hace cada cliente por WhatsApp. La aplicación solo puede añadir entradas: no puede cambiarlas ni borrarlas. |
| **Seguridad** | Aislamiento por clínica en todas las consultas y, además, en la propia base de datos (RLS con un rol que solo ve la clínica de cada petición), claves foráneas que impiden mezclar datos de dos clínicas, tokens de WhatsApp cifrados (AES-256-GCM), RLS que cierra la API de Supabase, webhooks firmados y, en el panel, una política de seguridad de contenido estricta y HTTPS obligatorio (HSTS). Las vulnerabilidades conocidas de las dependencias se revisan cada semana. |

## Proveedores que tratan datos

| Proveedor | Para qué | Qué datos | A revisar |
|---|---|---|---|
| Meta (WhatsApp Cloud API) | Enviar y recibir los mensajes | Teléfono, nombre de perfil y contenido de los mensajes | Condiciones de tratamiento de datos de WhatsApp Business |
| OpenAI | Clasificar los mensajes, interpretar fechas, responder preguntas frecuentes y transcribir notas de voz | Texto de los mensajes y audio de las notas de voz | Ver el apartado siguiente |
| DeepSeek (solo si se activa) | Proveedor de IA alternativo (no transcribe notas de voz) | Texto de los mensajes | Empresa china: los mensajes salen del Espacio Económico Europeo (EEE). Es una transferencia internacional que necesita garantías adecuadas (arts. 44 y siguientes). Está desactivado por defecto: solo se usa con `AI_PROVIDER=deepseek` o `FALLBACK_PROVIDER=deepseek` |
| Supabase | Base de datos | Todos | Crear el proyecto en una región de la UE y firmar su acuerdo de tratamiento de datos (DPA) |
| Railway | Servidor del bot | Todos, mientras se procesan | Región y DPA |
| Netlify | Panel web | Los que ve el personal en el panel | Región y DPA |
| Kinde | Inicio de sesión del panel | Email del personal | DPA |
| Chatwoot (opcional) | Atención humana | Copia de todas las conversaciones de WhatsApp, con la transcripción de las notas de voz | Si es autoalojado, los datos quedan en tu servidor |

### OpenAI

Según la documentación de OpenAI ([*Data controls*](https://developers.openai.com/api/docs/guides/your-data), consultada el 11/11/2026):

- **Entrenamiento:** los datos enviados por la API no se usan para entrenar modelos salvo que se acepte expresamente.
- **Registros de abuso:** se guardan hasta 30 días. Para la transcripción de audio (`/v1/audio/transcriptions`), la tabla de OpenAI indica que no se guardan («None»), consultada el 12/11/2026.
- **Residencia de datos en Europa:** existe, para almacenar y procesar en el EEE y Suiza, e incluye `/v1/chat/completions` y `/v1/audio/transcriptions`, los endpoints que usa ClinicAI. Para usarla:
  - Crea un proyecto con región Europa y pon `OPENAI_BASE_URL=https://eu.api.openai.com/v1`.
  - Necesitas la aprobación previa de OpenAI (controles de abuso y una enmienda de retención). Consulta con su equipo comercial si tu cuenta puede usarla.
  - OpenAI cobra un 10 % más en los modelos publicados desde el 5 de marzo de 2026.

**IA de respaldo:** si se activa (`ENABLE_FALLBACK=true`), por defecto es otro modelo de OpenAI (`OPENAI_FALLBACK_MODEL`), así que los datos no cambian de proveedor.

## Qué tiene que hacer la clínica

1. **Publicar su política de privacidad** y poner la URL en **Ajustes → Protección de datos**.
2. **Decidir la base jurídica** con su asesor. El aviso del bot pide una aceptación expresa; según el caso puede aplicar también la prestación del servicio o la asistencia sanitaria (arts. 6 y 9).
3. **Incluir el tratamiento en su registro de actividades** (art. 30).
4. **Firmar el contrato de encargo** (art. 28) con quien le presta ClinicAI y revisar la lista de proveedores.
5. **Valorar si necesita una evaluación de impacto** (EIPD, art. 35). Con datos de salud y uso de IA es recomendable hacerla.
6. **Elegir un plazo de conservación** en **Ajustes → Conservación de datos**.
7. **Atender las solicitudes de los clientes en el plazo de un mes** (art. 12.3), con *Exportar datos* y *Eliminar* desde la ficha del cliente.
8. **Cambiar la versión del aviso** (`PRIVACY_NOTICE_VERSION`, en `packages/shared/src/privacy.ts`) si cambia su texto. Los clientes que ya aceptaron no reciben el aviso nuevo automáticamente.

## Limitaciones conocidas

- **Personas que no se registran:** si Chatwoot está activo, sus mensajes también se copian allí. La aplicación solo borra los contactos de clientes registrados, así que esos se borran a mano en Chatwoot.
- **La exportación no incluye Chatwoot:** las conversaciones copiadas allí se exportan desde el propio Chatwoot.
- **Copias de seguridad:** las de la base de datos (Supabase) pueden conservar datos borrados durante su propio plazo de retención.
- **Contactos de Chatwoot sin borrar:** si Chatwoot no está configurado, o si el borrado falla 5 veces seguidas (por ejemplo porque el contacto sigue conectado), el contacto queda sin borrar. La tarea aparece como fallida en `/health` (`failedLast24h`) y en `inbound_events` (`source = 'internal'`, `status = 'failed'`), y hay que borrar el contacto a mano en Chatwoot.
- **Notas de voz en Meta:** el bot no guarda el audio, pero Meta lo conserva en sus servidores un tiempo limitado; el identificador que envía caduca a los 7 días.
- **Inactividad:** la política de conservación considera inactivo a quien no tiene citas. Un cliente que solo hace consultas por WhatsApp, sin pedir cita, puede ser anonimizado.
