/**
 * Minimal Ogg pages for tests (F16): only the header fields the duration reader uses are real.
 * Opus counts granules at 48 kHz, so `seconds * 48000` is the position of the last sample.
 */
export function oggPage(granule: bigint, payload: Buffer = Buffer.alloc(16, 1)): Buffer {
  const header = Buffer.alloc(27);
  header.write('OggS', 0, 'ascii');
  header.writeUInt8(0, 4); // version
  header.writeUInt8(4, 5); // header type: end of stream
  header.writeBigInt64LE(granule, 6);
  header.writeUInt8(1, 26); // one segment
  return Buffer.concat([header, Buffer.from([payload.length]), payload]);
}

/** A two-page Ogg "voice note" lasting `seconds`. */
export function fakeOgg(seconds: number): Buffer {
  return Buffer.concat([oggPage(0n), oggPage(BigInt(Math.round(seconds * 48_000)))]);
}
