import { describe, expect, it, vi } from 'vitest';
import {
  filterAllowedToolOps,
  setAllowedCanvasToolKeys,
} from '@/components/editor/panels/agent/toolOpsContract';
import { CanvasToolGateway } from '@/service/agentRuntime/CanvasToolGateway';
import {
  consumeMcpPendingBatches,
  type CanvasApplyResult,
  type CanvasSnapshot,
} from './mcpPendingConsumer';

const batch = {
  batchId: 'batch-1',
  runId: 'run-1',
  ops: [{ name: 'create_text', args: { text: 'BRIDGE SHAPE TEST', x: 100, y: 100 } }],
};

function harness() {
  const gateway = new CanvasToolGateway();
  let snapshot: CanvasSnapshot = { document: { deltaSetLike: {} }, nodeCount: 0, revision: 1 };
  const ack = vi.fn(async () => undefined);
  const applyOps = vi.fn(async (): Promise<CanvasApplyResult> => {
    snapshot = {
      document: { deltaSetLike: { n1: { id: 'n1', key: 'text' } } },
      nodeCount: 1,
      revision: 2,
    };
    return { opResults: [{ name: 'create_text', ok: true }] };
  });
  const run = (overrides: Partial<Parameters<typeof consumeMcpPendingBatches>[0]> = {}) =>
    consumeMcpPendingBatches({
      projectId: 'project-1',
      batches: [batch],
      gateway,
      filterOps: (ops) => (ops || []) as never,
      applyOps,
      getSnapshot: () => snapshot,
      ack,
      ...overrides,
    });
  return { gateway, ack, applyOps, run, getSnapshot: () => snapshot };
}

describe('consumeMcpPendingBatches', () => {
  it('does not ACK when filtering removes every op', async () => {
    const h = harness();
    const out = await h.run({ filterOps: () => [] });

    expect(h.applyOps).not.toHaveBeenCalled();
    expect(h.ack).not.toHaveBeenCalled();
    expect(out.traces[0]).toMatchObject({ inputCount: 1, filteredCount: 0, acked: false });
  });

  it('does not ACK when apply throws', async () => {
    const h = harness();
    const out = await h.run({ applyOps: vi.fn(async () => { throw new Error('apply failed'); }) });

    expect(h.ack).not.toHaveBeenCalled();
    expect(out.traces[0]).toMatchObject({ gateway: 'rejected', acked: false });
  });

  it('does not ACK a document mutation that returns without changing the scene', async () => {
    const h = harness();
    const out = await h.run({
      applyOps: vi.fn(async () => ({ opResults: [{ name: 'create_text', ok: true }] })),
    });

    expect(h.ack).not.toHaveBeenCalled();
    expect(out.traces[0]).toMatchObject({
      before: { nodeCount: 0, revision: 1 },
      after: { nodeCount: 0, revision: 1 },
      gateway: 'rejected',
      acked: false,
    });
  });

  it('ACKs only after a successful scene apply', async () => {
    const h = harness();
    const out = await h.run();

    expect(h.applyOps).toHaveBeenCalledTimes(1);
    expect(h.ack).toHaveBeenCalledWith('project-1', ['batch-1']);
    expect(out.traces[0]).toMatchObject({
      inputCount: 1,
      filteredCount: 1,
      tools: [{ name: 'create_text', argKeys: ['text', 'x', 'y'] }],
      before: { nodeCount: 0, revision: 1 },
      after: { nodeCount: 1, revision: 2 },
      gateway: 'accepted',
      acked: true,
    });
  });

  it('retries a failed ACK without applying the same operation twice', async () => {
    const h = harness();
    const ack = vi.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(undefined);

    await expect(h.run({ ack })).rejects.toThrow('network');
    const out = await h.run({ ack });

    expect(h.applyOps).toHaveBeenCalledTimes(1);
    expect(h.getSnapshot().nodeCount).toBe(1);
    expect(ack).toHaveBeenCalledTimes(2);
    expect(out.traces[0]).toMatchObject({ gateway: 'duplicate', acked: true });
  });

  it('rejects a late operation after run cancellation without mutating the scene', async () => {
    const h = harness();
    h.gateway.cancel('run-1', 'project-1');
    const out = await h.run();

    expect(h.applyOps).not.toHaveBeenCalled();
    expect(h.getSnapshot()).toMatchObject({ nodeCount: 0, revision: 1 });
    expect(h.ack).toHaveBeenCalledWith('project-1', ['batch-1']);
    expect(out.traces[0]).toMatchObject({ gateway: 'rejected', acked: true });
  });

  it('accepts the real create_text pending payload shape', () => {
    setAllowedCanvasToolKeys(['create_text']);

    const normalized = filterAllowedToolOps(batch.ops);

    expect(normalized).toEqual([
      { name: 'create_text', args: { text: 'BRIDGE SHAPE TEST', x: 100, y: 100 } },
    ]);
  });
});
