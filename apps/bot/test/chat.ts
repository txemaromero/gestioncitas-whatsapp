import type { Tenant } from '@clinicai/db';
import { renderOutgoingAsText, type IncomingMessage, type MessageHandler, type OutgoingMessage } from '../src/engine/types';
import { mockMediaId } from '../src/services/whatsapp';
import type { TestDeps } from './helpers';

let counter = 0;

/** Drives a conversation against the engine and returns the bot replies of each turn. */
export class Chat {
  constructor(
    private readonly deps: TestDeps,
    private readonly engine: MessageHandler,
    readonly tenant: Tenant,
    readonly phone: string,
  ) {}

  private async send(partial: Omit<IncomingMessage, 'tenantId' | 'phone' | 'waMessageId' | 'timestamp'>): Promise<OutgoingMessage[]> {
    counter += 1;
    const before = this.deps.whatsapp.outbox.length;
    await this.engine.handle(this.tenant, {
      tenantId: this.tenant.id,
      phone: this.phone,
      waMessageId: `wamid.test.${Date.now()}.${counter}`,
      timestamp: this.deps.clock.now(),
      ...partial,
    });
    await this.deps.background.idle();
    return this.deps.whatsapp.outbox.slice(before).filter((e) => e.to === this.phone).map((e) => e.message);
  }

  say(text: string): Promise<OutgoingMessage[]> {
    return this.send({ type: 'text', text, payloadId: null, rawType: 'text' });
  }

  press(id: string, title = id): Promise<OutgoingMessage[]> {
    return this.send({ type: 'button', text: title, payloadId: id, rawType: 'interactive' });
  }

  pick(id: string, title = id): Promise<OutgoingMessage[]> {
    return this.send({ type: 'list', text: title, payloadId: id, rawType: 'interactive' });
  }

  templateReply(payload: string, title: string): Promise<OutgoingMessage[]> {
    return this.send({ type: 'button', text: title, payloadId: payload, rawType: 'button' });
  }

  image(): Promise<OutgoingMessage[]> {
    return this.send({ type: 'other', text: '', payloadId: null, rawType: 'image' });
  }

  /** Voice note whose (mock) audio "says" `content`; a Buffer is sent as the raw audio file. */
  voice(content: string | Buffer, mimeType = 'audio/ogg; codecs=opus'): Promise<OutgoingMessage[]> {
    const media = { id: mockMediaId(content), mimeType, voice: true };
    return this.send({ type: 'other', text: '', payloadId: null, rawType: 'audio', media });
  }
}

export const texts = (messages: OutgoingMessage[]): string[] => messages.map(renderOutgoingAsText);
export const joined = (messages: OutgoingMessage[]): string => texts(messages).join('\n');

/** Ids of the buttons / list rows of the last interactive message. */
export function optionIds(messages: OutgoingMessage[]): string[] {
  const last = [...messages].reverse().find((m) => m.type === 'buttons' || m.type === 'list');
  if (!last) return [];
  if (last.type === 'buttons') return last.buttons.map((b) => b.id);
  if (last.type === 'list') return last.sections.flatMap((s) => s.rows.map((r) => r.id));
  return [];
}
