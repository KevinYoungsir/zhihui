#!/usr/bin/env node
/**
 * Stdio MCP bridge → Recombyn REST `/api/v1/mcp/canvas/*`.
 *
 * Env:
 *   RECOMBYN_API_URL   default http://127.0.0.1:8000
 *   RECOMBYN_TOKEN     Legacy web access token
 *   RECOMBYN_MCP_GRANT Short-lived desktop run grant (preferred)
 *   RECOMBYN_PROJECT_ID default project_id injected into tool calls
 *   RECOMBYN_RUN_ID    run id bound to the grant
 */
import readline from 'node:readline';

const API = (process.env.RECOMBYN_API_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const TOKEN = (process.env.RECOMBYN_TOKEN || '').trim();
const GRANT = (process.env.RECOMBYN_MCP_GRANT || '').trim();
const DEFAULT_PROJECT = (process.env.RECOMBYN_PROJECT_ID || '').trim();
const RUN_ID = (process.env.RECOMBYN_RUN_ID || '').trim();

let toolCatalog = [];

async function api(path, body, operationId) {
  const runScoped = Boolean(GRANT);
  const scopedPath = runScoped
    ? path === '/tools'
      ? '/runs/tools'
      : path === '/call'
        ? '/runs/call'
        : path
    : path;
  const res = await fetch(`${API}/api/v1/mcp/canvas${scopedPath}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${GRANT || TOKEN}`,
      'Content-Type': 'application/json',
      ...(operationId ? { 'X-Request-Id': operationId } : {}),
      ...(runScoped ? { 'X-Recombyn-Run-Id': RUN_ID } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data?.detail?.message || data?.detail || text || res.statusText;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

function injectProject(args) {
  const out = { ...(args || {}) };
  if (GRANT && DEFAULT_PROJECT) {
    delete out.projectId;
    out.project_id = DEFAULT_PROJECT;
    return out;
  }
  if (!out.project_id && !out.projectId && DEFAULT_PROJECT) {
    out.project_id = DEFAULT_PROJECT;
  }
  return out;
}

function toMcpTools(openAiTools) {
  return (openAiTools || []).map((t) => {
    const fn = t.function || {};
    return {
      name: fn.name,
      description: fn.description || fn.name,
      inputSchema: fn.parameters || { type: 'object', properties: {} },
    };
  });
}

async function refreshTools() {
  const data = await api('/tools');
  toolCatalog = toMcpTools(data.tools || []);
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handleMessage(line) {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;

  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'recombyn-canvas', version: '0.1.0' },
        },
      });
      return;
    }
    if (method === 'notifications/initialized') {
      return;
    }
    if (method === 'tools/list') {
      if (!toolCatalog.length) await refreshTools();
      send({ jsonrpc: '2.0', id, result: { tools: toolCatalog } });
      return;
    }
    if (method === 'tools/call') {
      const name = params?.name;
      const args = injectProject(params?.arguments || {});
      const operationId = params?.operationId || params?.operation_id || (
        id != null ? `${RUN_ID || 'mcp'}:${String(id)}` : undefined
      );
      const data = await api(
        '/call',
        { tool: name, arguments: args, ...(operationId ? { operationId } : {}) },
        operationId
      );
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(data.result ?? data, null, 2) }],
        },
      });
      return;
    }
    if (id != null) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    if (id != null) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: String(err?.message || err) },
      });
    }
  }
}

async function main() {
  if (!GRANT && !TOKEN) {
    console.error('RECOMBYN_MCP_GRANT or RECOMBYN_TOKEN is required');
    process.exit(1);
  }
  if (GRANT && !RUN_ID) {
    console.error('RECOMBYN_RUN_ID is required with a run grant');
    process.exit(1);
  }
  if (GRANT && !DEFAULT_PROJECT) {
    console.error('RECOMBYN_PROJECT_ID is required with a run grant');
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    await handleMessage(line);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
