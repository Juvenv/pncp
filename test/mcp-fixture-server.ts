import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
globalThis.fetch = async () => {
  const directory = process.env.PNCP_DATA_DIR!;
  const config = JSON.parse(readFileSync(join(directory, 'resposta.json'), 'utf8')) as {
    delay: number;
    payload: unknown;
  };
  writeFileSync(join(directory, 'fetch-started'), 'started');
  await delay(config.delay);
  return new Response(JSON.stringify(config.payload), { headers: { 'content-type': 'application/json' } });
};
await import('../src/mcp-server.js');
