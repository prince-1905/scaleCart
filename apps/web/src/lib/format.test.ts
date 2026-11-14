import { describe, expect, it } from 'vitest';
import { countdown, inr } from './format';

describe('format', () => {
  it('formats paise as rupees with Indian grouping', () => {
    expect(inr(249900)).toBe('₹2,499');
    expect(inr(12345678900)).toBe('₹12,34,56,789');
    expect(inr(1999)).toBe('₹19.99');
  });

  it('counts down as mm:ss, or h:mm:ss over an hour, never negative', () => {
    expect(countdown(65_000)).toBe('01:05');
    expect(countdown(3_725_000)).toBe('1:02:05');
    expect(countdown(-5_000)).toBe('00:00');
    expect(countdown(400)).toBe('00:01'); // rounds up: "00:00" only when it's really time
  });
});
