/**
 * Duration of an Ogg/Opus file (WhatsApp voice notes), read from the granule position of its
 * last page: Opus always counts granules at 48 kHz. Meta's webhook carries no duration (F16).
 * Returns null when the data is not Ogg or the position is not set.
 */
const OGG_CAPTURE = Buffer.from('OggS', 'ascii');
const OPUS_RATE = 48_000;

export function oggDurationSeconds(data: Buffer): number | null {
  const last = data.lastIndexOf(OGG_CAPTURE);
  // Page header: capture (4) + version (1) + header type (1) + granule position (8, little endian).
  if (last < 0 || last + 14 > data.length) return null;
  const granule = data.readBigInt64LE(last + 6);
  if (granule < 0n) return null;
  return Number(granule) / OPUS_RATE;
}

export function isOgg(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith('audio/ogg');
}
