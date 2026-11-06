import type { Server } from 'node:http';

let draining = false;

/** True once shutdown has started: the readiness probe reports "not ready" from then on. */
export const isDraining = () => draining;

/**
 * Graceful drain for a stopping replica. On SIGTERM it keeps serving for `drainMs`, but every
 * response carries `Connection: close`, so clients holding a keep-alive connection (NGINX, k6,
 * browsers) hang up after their current request and reconnect, which lands them on another
 * replica. Kubernetes already stopped routing *new* connections here. Then the app closes.
 *
 * Why: a preStop sleep only stops new connections. Requests on connections that were already
 * open still reached the closing server and failed (E7a: 503s from Fastify, EOFs, timeouts).
 */
export function attachDrain(server: Server) {
  // prependListener: runs before the framework's handler, so the header is set before the response is written.
  server.prependListener('request', (_req, res) => {
    if (draining) res.setHeader('connection', 'close');
  });
  return {
    /** Starts draining now; the caller closes the app afterwards. */
    start() {
      draining = true;
    },
  };
}

/** Wires SIGTERM/SIGINT: drain for `drainMs`, then run `close` (Nest's app.close: hooks, sockets) and exit. */
export function drainOnSignals(server: Server, drainMs: number, close: () => Promise<void>, log: (msg: string) => void) {
  const drain = attachDrain(server);
  const onSignal = (signal: NodeJS.Signals) => {
    if (draining) return;
    drain.start();
    log(`${signal}: draining for ${drainMs} ms (Connection: close, not ready), then closing`);
    setTimeout(() => {
      close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    }, drainMs);
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
}

/** For tests only: back to normal after a test started draining. */
export function stopDrainingForTests() {
  draining = false;
}
