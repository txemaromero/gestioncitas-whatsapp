import { describe, expect, it } from 'vitest';
import { fakeOgg, oggPage } from '../../test/ogg';
import { isOgg, oggDurationSeconds } from './ogg';

describe('oggDurationSeconds', () => {
  it('reads the duration from the granule position of the last page', () => {
    expect(oggDurationSeconds(fakeOgg(95))).toBe(95);
    expect(oggDurationSeconds(fakeOgg(2.5))).toBe(2.5);
  });

  it('ignores earlier pages', () => {
    const data = Buffer.concat([oggPage(48_000n * 300n), oggPage(48_000n * 12n)]);
    expect(oggDurationSeconds(data)).toBe(12);
  });

  it('returns null for data that is not Ogg, a truncated page or an unset position', () => {
    expect(oggDurationSeconds(Buffer.from('Quiero una cita', 'utf8'))).toBeNull();
    expect(oggDurationSeconds(Buffer.concat([oggPage(48_000n), Buffer.from('OggS\0')]))).toBeNull();
    expect(oggDurationSeconds(oggPage(-1n))).toBeNull();
  });
});

describe('isOgg', () => {
  it('recognises WhatsApp voice notes', () => {
    expect(isOgg('audio/ogg; codecs=opus')).toBe(true);
    expect(isOgg('audio/OGG')).toBe(true);
    expect(isOgg('audio/mpeg')).toBe(false);
  });
});
