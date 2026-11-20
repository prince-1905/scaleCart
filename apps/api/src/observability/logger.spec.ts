import type { IncomingMessage } from 'node:http';
import { requestIdOf } from './logger.js';

const req = (id?: string | string[]) => ({ headers: id === undefined ? {} : { 'x-request-id': id } }) as IncomingMessage;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('requestIdOf (the id every log line of a request carries)', () => {
  it("keeps the gateway's id", () => {
    expect(requestIdOf(req('23701b2e-5c83-405b-99c0-05dc15140541'))).toBe('23701b2e-5c83-405b-99c0-05dc15140541');
    expect(requestIdOf(req('req-e2e-123'))).toBe('req-e2e-123');
  });

  it('makes a new one when there is none', () => {
    expect(requestIdOf(req())).toMatch(UUID);
  });

  it('never logs what a client stuffed into the header: too long, odd characters, or repeated', () => {
    expect(requestIdOf(req('x'.repeat(65)))).toMatch(UUID);
    expect(requestIdOf(req('abc\n{"level":"fake"}'))).toMatch(UUID);
    expect(requestIdOf(req(['a', 'b']))).toMatch(UUID);
  });
});
