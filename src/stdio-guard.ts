// ============================================================
// stdio guard — keep plain-text logging off the MCP transport
// ============================================================
//
// The MCP stdio transport speaks JSON-RPC over stdout. Any stray plain-text
// write corrupts the stream and clients fail with
// "invalid character 'N' looking for beginning of value" (issue #9).
//
// import.ts and auto-ingest.ts use console.log legitimately for CLI progress
// output, so rewriting those ~80 call sites would be both large and wrong —
// and would not stop the 81st from being added. Redirect the stdout-writing
// console methods once, at the process boundary, instead.
//
// Import this FIRST in any entry point that speaks MCP over stdio. ESM
// evaluates imports in source order, so a first-position import runs before
// any other module's top-level code.

console.log = console.error;
console.info = console.error;
console.debug = console.error;
