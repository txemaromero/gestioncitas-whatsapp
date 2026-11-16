/**
 * AES-256-GCM helpers for secrets stored in the DB (e.g. per-tenant WhatsApp tokens).
 * Format: `v1.<iv b64>.<auth tag b64>.<ciphertext b64>`. Server-only (node:crypto).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function loadKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY debe ser una clave de 32 bytes en base64 (cómo generarla: README.md)');
  }
  return key;
}

export function encryptSecret(plaintext: string, base64Key: string): string {
  const key = loadKey(base64Key);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(
    '.',
  );
}

export function decryptSecret(payload: string, base64Key: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || dataB64 === undefined) {
    throw new Error('Unsupported encrypted payload format');
  }
  const key = loadKey(base64Key);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

/** Masks a secret for display: first 4 and last 4 characters. */
/**
 * F34: a key whose 32 bytes are all the same (like the all-zero key of the tests and CI) protects
 * nothing: `pnpm preflight` refuses it and the bot warns at startup.
 */
export function isTestEncryptionKey(base64Key: string): boolean {
  const key = Buffer.from(base64Key, 'base64');
  return key.length === 32 && key.every((b) => b === key[0]);
}

export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '••••';
  return `${secret.slice(0, 4)}••••••${secret.slice(-4)}`;
}
