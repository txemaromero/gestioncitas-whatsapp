# Plantillas de WhatsApp (Meta)

El bot inicia dos tipos de conversación, casi siempre **fuera de la ventana de atención de 24 horas**, así que WhatsApp solo admite **plantillas aprobadas** por Meta:

| Plantilla | Para qué | Variable de entorno |
|---|---|---|
| `recordatorio_cita` | Recordatorio de la cita: 1 o 2 días antes y, si la clínica lo activa, otro el mismo día (RF-W4, F30) | `WA_REMINDER_TEMPLATE` |
| `aviso_hueco_libre` | Aviso de hueco libre a la lista de espera (F17) | `WA_WAITLIST_TEMPLATE` |

Esta guía explica cómo crearlas y mandarlas a revisión. La segunda solo hace falta si la clínica activa la lista de espera (**Ajustes → Lista de espera**).

## Recordatorio: datos de la plantilla

| Campo | Valor |
|---|---|
| Nombre | `recordatorio_cita` (o el valor de `WA_REMINDER_TEMPLATE`) |
| Categoría | **Utility** (utilidad) |
| Idioma | Español, código `es` (o el de `WA_TEMPLATE_LANGUAGE`) |
| Cuerpo | `Hola {{1}}, te recordamos tu cita en {{2}} el {{3}} a las {{4}}.` |
| Ejemplos | `{{1}}` = `Laura`, `{{2}}` = `FisioDemo`, `{{3}}` = `jueves, 19 de noviembre`, `{{4}}` = `10:00` |
| Botón 1 | Respuesta rápida: `Sí, confirmo` |
| Botón 2 | Respuesta rápida: `No puedo asistir` |

Variables que rellena el bot (`apps/bot/src/jobs/reminders.ts`):

- `{{1}}`: nombre (de pila) del cliente.
- `{{2}}`: `clinic_name` del tenant.
- `{{3}}`: día de la cita en la zona del tenant (`jueves, 19 de noviembre`).
- `{{4}}`: hora de la cita en la zona del tenant (`HH:mm`).

> **F30:** antes el cuerpo decía «mañana» y tenía tres variables. Si ya enviaste la plantilla a revisión con ese texto, edítala en WhatsApp Manager con el nuevo (vuelve a revisión). `pnpm preflight` avisa si la plantilla aprobada no tiene las cuatro variables.

Al enviar, el bot asigna a cada botón un *payload* propio: `REMINDER_CONFIRM:<appointmentId>` para el índice 0 y `REMINDER_CANCEL:<appointmentId>` para el índice 1. Cuando el cliente pulsa uno, el webhook recibe un mensaje de tipo `button` con ese *payload* y `reminderResponseFlow` confirma o cancela la cita.

## Lista de espera: datos de la plantilla

| Campo | Valor |
|---|---|
| Nombre | `aviso_hueco_libre` (o el valor de `WA_WAITLIST_TEMPLATE`) |
| Categoría | **Utility** (utilidad): responde a una petición del propio cliente |
| Idioma | Español, código `es` (o el de `WA_TEMPLATE_LANGUAGE`) |
| Cuerpo | `Hola {{1}}, se ha liberado un hueco en {{2}}: {{3}}. ¿Quieres reservarlo? Si no respondes en {{4}} minutos, se lo ofreceremos a otra persona de la lista de espera.` |
| Ejemplos | `{{1}}` = `Laura`, `{{2}}` = `FisioDemo`, `{{3}}` = `martes, 8 de diciembre de 2026, 10:00`, `{{4}}` = `30` |
| Botón 1 | Respuesta rápida: `Reservar` |
| Botón 2 | Respuesta rápida: `No, gracias` |

Variables que rellena el bot (`apps/bot/src/jobs/waitlist.ts`): el nombre de pila del cliente, el nombre de la clínica, la fecha y hora del hueco en la zona de la clínica y los minutos para responder (`WAITLIST_OFFER_MINUTES`). Los *payloads* de los botones son `WAITLIST_BOOK:<entrada>` y `WAITLIST_SKIP:<entrada>`; también vale responder «sí» o «no» mientras el aviso está abierto.

> Reglas de Meta que conviene recordar: una variable no puede ir al principio ni al final del texto (error 2388299), cada variable necesita un ejemplo, las etiquetas de respuesta rápida tienen como máximo 25 caracteres y una plantilla de utilidad no debe incluir contenido promocional (si no, Meta la reclasifica como *marketing*).

## Opción A: desde el panel (WhatsApp Manager)

1. Entra en [business.facebook.com](https://business.facebook.com) → **WhatsApp Manager** → **Plantillas de mensajes** → **Crear plantilla**.
2. Categoría **Utilidad**. Nombre `recordatorio_cita`. Idioma **Español**.
3. Cuerpo: pega el texto de la tabla y añade los cuatro ejemplos.
4. Botones → **Respuesta rápida** → `Sí, confirmo` y `No puedo asistir`.
5. **Enviar para revisión**. El estado pasa de `PENDING` a `APPROVED`, normalmente en minutos u horas. Hasta que se apruebe, el envío falla y el bot libera la cita para reintentarlo en la siguiente ejecución.
6. Para la lista de espera, repite los pasos con `aviso_hueco_libre`, su cuerpo, los cuatro ejemplos y los botones `Reservar` y `No, gracias`. Si se activa la lista de espera sin la plantilla aprobada, los avisos fallan (queda en el registro `waiting list offer not sent`) y ese hueco no se vuelve a ofrecer a ese cliente.

## Opción B: con la API (Graph API v27.0)

```bash
curl -X POST "https://graph.facebook.com/v27.0/$WABA_ID/message_templates" \
  -H "Authorization: Bearer $META_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "recordatorio_cita",
    "language": "es",
    "category": "UTILITY",
    "components": [
      {
        "type": "BODY",
        "text": "Hola {{1}}, te recordamos tu cita en {{2}} el {{3}} a las {{4}}.",
        "example": { "body_text": [["Laura", "FisioDemo", "jueves, 19 de noviembre", "10:00"]] }
      },
      {
        "type": "BUTTONS",
        "buttons": [
          { "type": "QUICK_REPLY", "text": "Sí, confirmo" },
          { "type": "QUICK_REPLY", "text": "No puedo asistir" }
        ]
      }
    ]
  }'
```

Para la lista de espera, la misma llamada con este contenido:

```json
{
  "name": "aviso_hueco_libre",
  "language": "es",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "Hola {{1}}, se ha liberado un hueco en {{2}}: {{3}}. ¿Quieres reservarlo? Si no respondes en {{4}} minutos, se lo ofreceremos a otra persona de la lista de espera.",
      "example": { "body_text": [["Laura", "FisioDemo", "martes, 8 de diciembre de 2026, 10:00", "30"]] }
    },
    {
      "type": "BUTTONS",
      "buttons": [
        { "type": "QUICK_REPLY", "text": "Reservar" },
        { "type": "QUICK_REPLY", "text": "No, gracias" }
      ]
    }
  ]
}
```

`WABA_ID` es el identificador de la cuenta de WhatsApp Business (no el `phone_number_id`). Para consultar el estado:

```bash
curl "https://graph.facebook.com/v27.0/$WABA_ID/message_templates?name=recordatorio_cita" \
  -H "Authorization: Bearer $META_JWT_TOKEN"
```

## Probar el envío

```bash
# Envío manual del job (todas las citas pendientes de mañana del tenant)
curl -X POST "$BOT_URL/jobs/reminders/run" \
  -H "x-cron-secret: $CRON_SECRET" -H "Content-Type: application/json" \
  -d '{"tenantId": "<uuid del tenant>"}'
```

Sin Meta, en local: `pnpm bot:simulate --tenant fisiodemo --phone +34611111111`, `/avanzar 1d` si hace falta y `/recordatorios`. Después pulsa `#1` («Sí, confirmo»).

Lista de espera: `POST $BOT_URL/jobs/waitlist/run` con la misma cabecera (el bot ya lo ejecuta cada 5 minutos y tras cada cancelación por WhatsApp). En el simulador, pide una cita en un día completo, pulsa «🔔 Avisarme», libera un hueco (por ejemplo, cancelando una cita en el panel) y escribe `/lista-espera`.

## Coste

Las conversaciones de utilidad iniciadas por la empresa se facturan por plantilla entregada (≈ 0,018 € según la estimación de costes del proyecto). Por eso el sistema envía **como máximo un recordatorio por cita** (`appointments.reminder_sent_at`). Los avisos de la lista de espera se envían de uno en uno, solo cuando hay un hueco para ese cliente, y nunca dos veces el mismo hueco al mismo cliente. Ningún otro mensaje iniciado por el negocio sale fuera de estas dos plantillas.
