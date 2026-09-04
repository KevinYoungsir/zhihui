import type { AgentToolOp } from '@/components/editor/panels/agent/toolOpsContract';
import type { McpPendingBatch } from '@/service/mcpCanvas';
import type {
  CanvasToolGatewayApplyRequest,
} from '@/service/agentRuntime/CanvasToolGateway';

export type CanvasApplyResult = {
  opResults?: Array<{ name?: string; ok?: boolean }>;
};

export type CanvasSnapshot = {
  document: unknown;
  nodeCount: number;
  revision: number;
};

type PendingGateway = {
  isCancelled(runId: string, projectId: string): boolean;
  acquire(runId: string, projectId: string): void;
  release(runId: string, projectId: string): void;
  apply<T>(request: CanvasToolGatewayApplyRequest<T>): Promise<T | null>;
};

export type PendingBatchTrace = {
  batchId: string;
  runId: string;
  inputCount: number;
  filteredCount: number;
  tools: Array<{ name: string; argKeys: string[] }>;
  before?: Omit<CanvasSnapshot, 'document'>;
  after?: Omit<CanvasSnapshot, 'document'>;
  gateway: 'not-called' | 'accepted' | 'duplicate' | 'rejected';
  acked: boolean;
};

export type ConsumePendingOptions = {
  projectId: string;
  batches: McpPendingBatch[];
  gateway: PendingGateway;
  filterOps: (ops: McpPendingBatch['ops']) => AgentToolOp[];
  applyOps: (ops: AgentToolOp[], signal: AbortSignal) => Promise<CanvasApplyResult>;
  getSnapshot: () => CanvasSnapshot;
  ack: (projectId: string, batchIds: string[]) => Promise<unknown>;
};

const NON_DOCUMENT_TOOLS = new Set([
  'set_viewport',
  'set_active_tool',
  'set_grid',
  'set_agent_mode',
  'toggle_editor_panel',
  'export_canvas',
  'finish',
]);

function safeSnapshot(snapshot: CanvasSnapshot): Omit<CanvasSnapshot, 'document'> {
  return { nodeCount: snapshot.nodeCount, revision: snapshot.revision };
}

function hasCompleteSuccessfulReceipts(
  ops: AgentToolOp[],
  result: CanvasApplyResult
): boolean {
  const counts = new Map<string, number>();
  for (const receipt of result.opResults || []) {
    if (!receipt?.ok) continue;
    const name = String(receipt.name || '').trim();
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  for (const op of ops) {
    const name = String(op.name || '').trim();
    const remaining = counts.get(name) || 0;
    if (!name || remaining <= 0) return false;
    counts.set(name, remaining - 1);
  }
  return true;
}

function assertConsumed(
  ops: AgentToolOp[],
  result: CanvasApplyResult,
  before: CanvasSnapshot,
  after: CanvasSnapshot
): void {
  if (!hasCompleteSuccessfulReceipts(ops, result)) {
    throw new Error('mcp_pending_apply_incomplete');
  }
  const requiresDocumentChange = ops.some((op) => !NON_DOCUMENT_TOOLS.has(op.name));
  const changed = before.document !== after.document || before.revision !== after.revision;
  if (requiresDocumentChange && !changed) {
    throw new Error('mcp_pending_apply_noop');
  }
}

/** Consume in order; ACK only batches proven applied (or already applied by operationId). */
export async function consumeMcpPendingBatches(
  options: ConsumePendingOptions
): Promise<{ ackIds: string[]; traces: PendingBatchTrace[] }> {
  const ackIds: string[] = [];
  const traces: PendingBatchTrace[] = [];

  for (const batch of options.batches) {
    const batchId = String(batch.batchId || '').trim();
    const runId = String(batch.runId || `mcp-${options.projectId}`);
    const inputOps = Array.isArray(batch.ops) ? batch.ops : [];
    const trace: PendingBatchTrace = {
      batchId,
      runId,
      inputCount: inputOps.length,
      filteredCount: 0,
      tools: [],
      gateway: 'not-called',
      acked: false,
    };
    traces.push(trace);

    if (!batchId) break;
    if (options.gateway.isCancelled(runId, options.projectId)) {
      trace.gateway = 'rejected';
      ackIds.push(batchId);
      continue;
    }

    const normalized = options.filterOps(inputOps);
    trace.filteredCount = normalized.length;
    trace.tools = normalized.map((op) => ({
      name: op.name,
      argKeys: Object.keys(op.args || {}).sort(),
    }));
    if (!normalized.length) break;

    let acquired = false;
    try {
      options.gateway.acquire(runId, options.projectId);
      acquired = true;
      const result = await options.gateway.apply({
        runId,
        projectId: options.projectId,
        operationId: batchId,
        ops: normalized,
        apply: async (canonicalOps, signal) => {
          const before = options.getSnapshot();
          trace.before = safeSnapshot(before);
          const applied = await options.applyOps(canonicalOps, signal);
          const after = options.getSnapshot();
          trace.after = safeSnapshot(after);
          assertConsumed(canonicalOps, applied, before, after);
          return applied;
        },
      });
      trace.gateway = result === null ? 'duplicate' : 'accepted';
      ackIds.push(batchId);
    } catch {
      trace.gateway = 'rejected';
      break;
    } finally {
      if (acquired) options.gateway.release(runId, options.projectId);
    }
  }

  if (ackIds.length) {
    await options.ack(options.projectId, ackIds);
    for (const trace of traces) {
      if (ackIds.includes(trace.batchId)) trace.acked = true;
    }
  }
  return { ackIds, traces };
}
