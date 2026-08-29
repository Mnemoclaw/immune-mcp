#!/usr/bin/env node
'use strict';

// immune-mcp — MCP server exposing the MnemoClaw immune memory to any
// MCP client (Claude Desktop, Claude Code, Cursor, ...).
//
// Repo: https://github.com/Mnemoclaw/immune-mcp
//
// Architecture (deliberately thin — the adapter owns the engine):
//
//   ┌────────────────────┐        spawn          ┌──────────────────────────┐
//   │  MCP client        │ ◀── stdio (JSON-RPC) ─┤  immune-mcp (this file)  │
//   │  Claude / Cursor / │                       └───────────┬──────────────┘
//   │  any MCP host      │                                   │ execFile(node)
//   └────────────────────┘                                   ▼
//                                                 immune-adapter.js (CLI)
//                                                 CPU standalone (MiniLM + FTS4 + RRF)
//                                                 or full MnemoClaw install
//                                                 (daemon-first: Nemotron + rerank)
//
// The engine choice is delegated to the adapter: against an npm standalone
// install you get the CPU engine, against a full MnemoClaw install the
// adapter transparently uses the GPU embed daemon when reachable.
//
// Config (env):
//   IMMUNE_DIR      directory containing immune-adapter.js
//                   (def: auto-discovery, see findAdapter)
//   MNEMOCLAW_HOME  root of a full MnemoClaw install (ex: ~/mnemoclaw-docker)
//   IMMUNE_MCP_DEBUG "1" → verbose stderr diagnostics

const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const DEBUG = process.env.IMMUNE_MCP_DEBUG === '1';
const log = (...a) => { if (DEBUG) console.error('[immune-mcp]', ...a); };

// ── Adapter discovery ─────────────────────────────────────────────────

function findAdapter() {
  const candidates = [];
  if (process.env.IMMUNE_DIR) {
    candidates.push(path.join(process.env.IMMUNE_DIR, 'immune-adapter.js'));
  }
  if (process.env.MNEMOCLAW_HOME) {
    candidates.push(path.join(process.env.MNEMOCLAW_HOME, 'workspace', 'immune', 'immune-adapter.js'));
  }
  const home = os.homedir();
  // npm standalone install (`npm i -g @mnemoclaw/immune && immune init`)
  candidates.push(path.join(home, '.claude', 'skills', 'immune', 'immune-adapter.js'));
  // full MnemoClaw install at the default location
  candidates.push(path.join(home, 'mnemoclaw-docker', 'workspace', 'immune', 'immune-adapter.js'));
  // git clone of MnemoClaw/immune next to this package
  candidates.push(path.join(__dirname, 'node_modules', '@mnemoclaw', 'immune', 'immune-adapter.js'));
  candidates.push(path.join(process.cwd(), 'immune-adapter.js'));

  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

const ADAPTER = findAdapter();
log('adapter:', ADAPTER || 'NOT FOUND');

// ── Adapter invocation ────────────────────────────────────────────────

function runAdapter(cmdArgs, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!ADAPTER) {
      return reject(new Error(
        'immune-adapter.js not found. Either:\n' +
        '  1. npm install -g @mnemoclaw/immune && immune init   (standalone CPU engine), or\n' +
        '  2. set IMMUNE_DIR to a directory containing immune-adapter.js, or\n' +
        '  3. set MNEMOCLAW_HOME to a full MnemoClaw install.'
      ));
    }
    execFile(
      process.execPath,
      [ADAPTER, ...cmdArgs],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        log('cmd:', cmdArgs.join(' '), '→', err ? `ERR ${err.message}` : 'ok');
        if (stderr) log('adapter stderr:', stderr.slice(0, 500));
        if (err) return reject(new Error(`adapter failed: ${err.message}${stderr ? ' — ' + stderr.slice(0, 300) : ''}`));
        // The adapter prints exactly one JSON line on stdout.
        const lines = (stdout || '').trim().split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try { return resolve(JSON.parse(lines[i])); } catch { /* keep looking */ }
        }
        reject(new Error(`adapter returned no JSON: ${String(stdout).slice(0, 300)}`));
      }
    );
  });
}

// ── Formatting helpers ────────────────────────────────────────────────

const trunc = (s, n) => {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

function formatAntibody(ab) {
  const sev = (ab.severity || 'info').toUpperCase();
  const out = [`[${ab.id} | ${sev}] ${trunc(ab.pattern, 200)}`];
  if (ab.correction) out.push(`  ↳ fix: ${trunc(ab.correction, 200)}`);
  return out.join('\n');
}

function formatStrategy(cs) {
  const eff = cs.effectiveness != null ? ` | eff ${(cs.effectiveness * 100).toFixed(0)}%` : '';
  const out = [`[${cs.id}${eff}] ${trunc(cs.pattern, 200)}`];
  if (cs.example) out.push(`  ↳ ex: ${trunc(cs.example, 150)}`);
  return out.join('\n');
}

// ── MCP server ────────────────────────────────────────────────────────

const server = new McpServer({ name: 'immune-mcp', version: '0.1.0' });

// First retrieval on a cold standalone install downloads the embedding
// model (~22 MB) and warms WASM — allow generous time.
const RECALL_TIMEOUT = 180_000;
const WRITE_TIMEOUT = 60_000;
const FAST_TIMEOUT = 45_000;

server.tool(
  'immune_recall',
  'Search the MnemoClaw immune memory: known errors to avoid (antibodies) ' +
  'and proven best practices (strategies). Use before producing or fixing ' +
  'code to exploit accumulated experience.',
  {
    query: z.string().optional().describe('Natural language query (ex: "sql injection node.js"). Omit to list top items of the tier.'),
    type: z.enum(['all', 'antibodies', 'strategies']).optional().describe('Which memory to search. Default: all.'),
    tier: z.enum(['hot', 'all', 'cold']).optional().describe("'hot' = active patterns (default), 'all', 'cold' = dormant."),
    domains: z.array(z.string()).optional().describe("Filter by domains, ex ['code']. Omit for no filter (whole memory)."),
    limit: z.number().int().min(1).max(50).optional().describe('Max items per type. Default: 8.')
  },
  async ({ query, type, tier, domains, limit }) => {
    // Portable surface: get-antibodies / get-strategies exist in BOTH the
    // standalone repo (v5.2, no `get-all`) and the full MnemoClaw adapter.
    // type 'all' → two parallel spawns.
    const flags = [];
    if (query) flags.push('--query', query);
    flags.push('--tier', tier || 'hot');
    flags.push('--limit', String(limit || 8));
    if (domains && domains.length) flags.push('--domains', JSON.stringify(domains));

    const jobs = [];
    if (type !== 'strategies') jobs.push(runAdapter(['get-antibodies', ...flags], RECALL_TIMEOUT));
    if (type !== 'antibodies') jobs.push(runAdapter(['get-strategies', ...flags], RECALL_TIMEOUT));
    // Order: [antibodies?, strategies?] — flag missing halves as null
    const withType = jobs.map((p, i) => p.then(r => ({ r, kind: (type === 'strategies') ? 'strategies' : (type === 'antibodies' ? 'antibodies' : (i === 0 ? 'antibodies' : 'strategies')) })));
    const settled = await Promise.all(withType);

    const parts = [];
    for (const { r, kind } of settled) {
      if (r && r.error) return { content: [{ type: 'text', text: `Error: ${r.error}` }], isError: true };
      if (kind === 'antibodies') {
        const list = r.antibodies || [];
        parts.push(`── Antibodies (${list.length})${r.reranked ? ' [reranked]' : ''}`);
        parts.push(list.length ? list.map(formatAntibody).join('\n\n') : '(none)');
      } else {
        const list = r.strategies || [];
        parts.push(`── Strategies (${list.length})${r.reranked ? ' [reranked]' : ''}`);
        parts.push(list.length ? list.map(formatStrategy).join('\n\n') : '(none)');
      }
    }
    return { content: [{ type: 'text', text: parts.join('\n') }] };
  }
);

server.tool(
  'immune_learn',
  "Learn a new pattern into the MnemoClaw immune memory for reuse by all " +
  "agents. 'antibody' = error to avoid (with correction). 'strategy' = " +
  "reusable best practice. Patterns must be generalizable (min 20 chars).",
  {
    kind: z.enum(['antibody', 'strategy']).describe("'antibody' or 'strategy'"),
    pattern: z.string().min(20).describe('Generalized pattern (min 20 characters).'),
    correction: z.string().optional().describe('[antibody] How to fix/avoid.'),
    severity: z.enum(['critical', 'warning', 'info']).optional().describe("[antibody] 'critical' | 'warning' | 'info'. Default: 'warning'."),
    example: z.string().optional().describe('[strategy] Concrete example.'),
    domains: z.array(z.string()).optional().describe("Domains, ex ['code']. Default: ['_global'].")
  },
  async ({ kind, pattern, correction, severity, example, domains }) => {
    const stamp = Date.now().toString(36).toUpperCase();
    let payload, cmd;
    if (kind === 'antibody') {
      if (!correction) {
        return { content: [{ type: 'text', text: "Error: 'correction' is required for an antibody (how to fix/avoid)." }], isError: true };
      }
      cmd = 'add-antibody';
      payload = {
        id: `AB-MCP-${stamp}`,
        pattern, severity: severity || 'warning', correction,
        domains: domains && domains.length ? domains : ['_global']
      };
    } else {
      cmd = 'add-strategy';
      payload = {
        id: `CS-MCP-${stamp}`,
        pattern, effectiveness: 0.5,
        domains: domains && domains.length ? domains : ['_global']
      };
      if (example) payload.example = example;
    }
    const res = await runAdapter([cmd, '--json', JSON.stringify(payload)], WRITE_TIMEOUT);
    if (res && res.error) return { content: [{ type: 'text', text: `Error: ${res.error}` }], isError: true };
    return { content: [{ type: 'text', text: `Learned ${kind} ${payload.id} into the immune memory.` }] };
  }
);

server.tool(
  'immune_stats',
  'Health of the MnemoClaw immune memory: antibody/strategy counts, tiers, storage state.',
  {},
  async () => {
    const res = await runAdapter(['stats'], FAST_TIMEOUT);
    return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
  }
);

// ── Boot ──────────────────────────────────────────────────────────────

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('ready — tools: immune_recall, immune_learn, immune_stats');
})().catch((e) => {
  console.error('[immune-mcp] fatal:', e);
  process.exit(1);
});
