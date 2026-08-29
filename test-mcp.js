#!/usr/bin/env node
'use strict';
// Test driver: pilote immune-mcp en JSON-RPC sur stdio.
const { spawn } = require('child_process');

const proc = spawn(process.execPath, [require('path').join(__dirname, 'index.js')], {
  env: { ...process.env, IMMUNE_DIR: process.env.IMMUNE_DIR, IMMUNE_MCP_DEBUG: '0' },
  stdio: ['pipe', 'pipe', 'inherit']
});

let id = 0;
const pending = new Map();
const results = [];

proc.stdout.on('data', (buf) => {
  for (const line of buf.toString().split('\n').filter(Boolean)) {
    let msg; try { msg = JSON.parse(line); } catch { console.error('NON-JSON:', line.slice(0, 120)); continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

function send(method, params) {
  return new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    proc.send ? null : null;
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
  });
}
function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

(async () => {
  const init = await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-driver', version: '0.0.1' }
  });
  console.log('✓ initialize →', init.result.serverInfo.name, init.result.serverInfo.version);
  notify('notifications/initialized', {});

  const tools = await send('tools/list', {});
  console.log('✓ tools/list →', tools.result.tools.map(t => t.name).join(', '));

  async function call(name, args, label) {
    const r = await send('tools/call', { name, arguments: args });
    const ok = !r.result?.isError;
    const text = (r.result?.content?.[0]?.text || JSON.stringify(r)).slice(0, 400);
    console.log(`${ok ? '✓' : '✗'} ${label}\n${text}\n`);
    results.push([label, ok]);
  }

  await call('immune_stats', {}, 'stats (mémoire vide)');
  await call('immune_learn', { kind: 'antibody', pattern: 'Using string concatenation to build SQL queries instead of parameterized statements', correction: 'Always use parameterized queries or an ORM; concat invites SQL injection.', severity: 'critical', domains: ['code'] }, 'learn antibody');
  await call('immune_learn', { kind: 'strategy', pattern: 'Run automated smoke tests before pushing to production branches', example: 'npm run smoke && npm test && git push', domains: ['code'] }, 'learn strategy');
  await call('immune_recall', { tier: 'all', limit: 5 }, 'recall sans query');
  await call('immune_recall', { query: 'sql injection database', type: 'all', tier: 'all', limit: 5 }, 'recall avec query (rerank)');

  const failed = results.filter(([, ok]) => !ok);
  console.log(failed.length ? `ÉCHECS: ${failed.map(([l]) => l).join(', ')}` : `TOUS OK (${results.length}/${results.length})`);
  proc.kill();
  process.exit(failed.length ? 1 : 0);
})();
