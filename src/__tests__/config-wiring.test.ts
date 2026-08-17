import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { GeminiEmbeddings } from '../embeddings.js';

// ============================================================
// GOOGLE_GEMINI_BASE_URL must reroute real API traffic
// ============================================================

let stub: Server;
let stubUrl: string;
const received: Array<{ url: string; headers: Record<string, string | string[] | undefined> }> = [];

beforeAll(async () => {
  stub = createServer((req, res) => {
    received.push({ url: req.url!, headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ embedding: { values: [0.1, 0.2, 0.3] } }));
  });
  await new Promise<void>(r => stub.listen(0, '127.0.0.1', r));
  const addr = stub.address() as { port: number };
  stubUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>(r => stub.close(() => r()));
});

describe('GOOGLE_GEMINI_BASE_URL', () => {
  it('redirects Gemini embedding traffic to the configured host', async () => {
    const prev = process.env.GOOGLE_GEMINI_BASE_URL;
    process.env.GOOGLE_GEMINI_BASE_URL = stubUrl;
    try {
      const embedder = new GeminiEmbeddings('test-key', 'test-embed-model');
      const vec = await embedder.embed('hello');
      expect(vec).toEqual([0.1, 0.2, 0.3]);
      expect(received).toHaveLength(1);
      expect(received[0].url).toBe('/v1beta/models/test-embed-model:embedContent');
      // The key travels in a header, never the URL — request URLs are logged
      // in full by every proxy between here and the API.
      expect(received[0].url).not.toContain('test-key');
      expect(received[0].headers['x-goog-api-key']).toBe('test-key');
    } finally {
      if (prev === undefined) delete process.env.GOOGLE_GEMINI_BASE_URL;
      else process.env.GOOGLE_GEMINI_BASE_URL = prev;
    }
  });
});
