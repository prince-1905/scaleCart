import { randomBytes } from 'node:crypto';

/**
 * UUID version 7 (RFC 9562): 48-bit millisecond timestamp first, then random bits.
 *
 * Why not random v4? InnoDB stores rows in primary-key order. Random keys land all
 * over the index (page splits, poor cache use); time-ordered keys append at the end,
 * like AUTO_INCREMENT, while staying unguessable and generatable before the INSERT.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
