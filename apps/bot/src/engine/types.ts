import type { Tenant } from '@clinicai/db';

/** Handles one normalized message for a resolved tenant (the conversation engine). */
export interface MessageHandler {
  handle(tenant: Tenant, message: IncomingMessage): Promise<void>;
}

/** Normalized incoming WhatsApp message. */
export interface IncomingMessage {
  tenantId: string;
  /** E.164 */
  phone: string;
  type: 'text' | 'button' | 'list' | 'other';
  /** Text body, or the title of the pressed button / list row. */
  text: string;
  /** Button / list row id, or template quick-reply payload. */
  payloadId: string | null;
  waMessageId: string;
  /** Original WhatsApp type (`text`, `interactive`, `button`, `image`, `audio`…). */
  rawType: string;
  timestamp: Date;
  profileName?: string;
  /** Attached audio (F16: voice notes), downloaded and transcribed by the engine. */
  media?: { id: string; mimeType: string | null; voice: boolean };
  /** The text comes from transcribing a voice note (F16). */
  transcribed?: boolean;
  /** Why a voice note could not be turned into text (F16). */
  voiceIssue?: 'too_long' | 'unavailable' | 'empty' | 'no_consent';
}

export interface ReplyButton {
  id: string;
  title: string;
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

export type OutgoingMessage =
  | { type: 'text'; text: string }
  | { type: 'buttons'; body: string; buttons: ReplyButton[]; footer?: string }
  | {
      type: 'list';
      body: string;
      buttonText: string;
      sections: { title?: string; rows: ListRow[] }[];
      footer?: string;
    }
  | {
      type: 'template';
      name: string;
      language: string;
      bodyParams: string[];
      /** Payloads for the template quick-reply buttons, in order (index 0, 1, …). */
      quickReplyPayloads: string[];
      /** Human-readable rendering for logs / Chatwoot mirror / simulator. */
      preview: string;
      previewButtons: string[];
    };

/** Plain-text rendering of an outgoing message (Chatwoot mirror, simulator, logs). */
export function renderOutgoingAsText(message: OutgoingMessage): string {
  switch (message.type) {
    case 'text':
      return message.text;
    case 'buttons':
      return `${message.body}\n${message.buttons.map((b) => `[${b.title}]`).join(' ')}`;
    case 'list':
      return `${message.body}\n${message.sections
        .flatMap((s) => s.rows)
        .map((r) => `• ${r.title}${r.description ? ` (${r.description})` : ''}`)
        .join('\n')}`;
    case 'template':
      return `${message.preview}\n${message.previewButtons.map((b) => `[${b}]`).join(' ')}`;
  }
}
