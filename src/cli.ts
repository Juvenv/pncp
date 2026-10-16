import { Service } from './service.js';
const [command, ...args] = process.argv.slice(2);
if (command === 'doctor') {
  const s = new Service();
  try {
    const integrity = s.store.db.prepare('PRAGMA quick_check').all();
    const ok = integrity.every(row => row.quick_check === 'ok');
    console.log(JSON.stringify({ status: ok ? 'ok_local' : 'error', node: process.version, database: s.store.path, sqlite: 'node:sqlite', schema: s.store.db.prepare('PRAGMA user_version').get()?.user_version, integrity, network: 'não testada', data_dir_source: process.env.PNCP_DATA_DIR ? 'PNCP_DATA_DIR' : 'diretório atual/dados', pendencias: ['Reinicie processos MCP após recompilar.', 'Este diagnóstico não valida disponibilidade do PNCP ou conteúdo das atas.'] }, null, 2));
    if (!ok)
      process.exitCode = 1;
  }
  finally {
    s.close();
  }
}
else if (command === 'iniciar') {
  const s = new Service();
  try {
    console.log(JSON.stringify(s.start(args), null, 2));
  }
  finally {
    s.close();
  }
}
else {
  console.error('Uso: npm run doctor | npx tsx src/cli.ts iniciar termo1 termo2');
  process.exitCode = 2;
}
