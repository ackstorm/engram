// ============================================================
// Version
// ============================================================
//
// This replaces update-check.ts, which polled the npm registry for
// `engram-sdk` every four hours and, on a newer release, told the user to run
// `npm update -g engram-sdk`. That package is upstream's. Following the advice
// would have replaced this fork with the code it forked away from — losing the
// required auth token, the loopback bind, the scope split and every fix in
// between. It also meant an outbound call to npmjs.org from a tool whose
// selling point is that it only talks to your own embedding endpoint.

import { readFileSync } from 'fs';

/** The version from package.json, or 0.0.0 if it cannot be read. */
export function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}
