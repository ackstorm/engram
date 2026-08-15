// Fixture for stdio-guard.test.ts — must import the guard FIRST.
import '../../stdio-guard.js';

console.log('LOG_NOISE');
console.info('INFO_NOISE');
console.debug('DEBUG_NOISE');
console.error('ERROR_NOISE');
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }) + '\n');
