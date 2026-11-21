import { UUID_PATTERN, uuidv7 } from './uuid.js';

describe('uuidv7', () => {
  it('has the v7 version and RFC variant bits', () => {
    const id = uuidv7();
    expect(id).toMatch(UUID_PATTERN);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('sorts by creation time', () => {
    const ids = [3, 1, 2].map((t) => uuidv7(1_700_000_000_000 + t));
    expect([...ids].sort()).toEqual([ids[1], ids[2], ids[0]]);
  });

  it('encodes the timestamp in the first 48 bits', () => {
    const t = 1_700_000_000_123;
    const id = uuidv7(t);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(t);
  });
});
