import { Service } from './service.js';

const [command, ...args] = process.argv.slice(2);
if (command === 'doctor') {
  const s = new Service();
  try { console.log(JSON.stringify({ status: 'ok', node: process.version, database: s.store.path, sqlite: 'node:sqlite' }, null, 2)); } finally { s.close(); }
} else if (command === 'iniciar') {
  const s = new Service();
  try { console.log(JSON.stringify(s.start(args), null, 2)); } finally { s.close(); }
} else {
  console.error('Uso: npm run doctor | npx tsx src/cli.ts iniciar termo1 termo2'); process.exitCode = 2;
}
