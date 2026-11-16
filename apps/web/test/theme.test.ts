/**
 * Panel theme: the edge of the form fields must be visible on every background they sit on
 * (WCAG 2.1 SC 1.4.11, non-text contrast ≥ 3:1). axe in the e2e does not measure this.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.resolve(import.meta.dirname, '../src/app/globals.css'), 'utf8');

/** Hex value of a theme token in `:root`. */
function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
  if (!match) throw new Error(`token --${name} not found`);
  return match[1]!;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

describe('theme', () => {
  it.each(['background', 'card', 'popover', 'muted'])('field edges stand out at least 3:1 on --%s', (background) => {
    expect(contrast(token('input'), token(background))).toBeGreaterThanOrEqual(3);
  });
});
