import { TRPCError } from '@trpc/server';

/** ENCRYPTION_KEY of the server (WhatsApp tokens, agenda links); the same as the bot's. */
export function encryptionKey(): string {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'ENCRYPTION_KEY no está configurada' });
  return key;
}
