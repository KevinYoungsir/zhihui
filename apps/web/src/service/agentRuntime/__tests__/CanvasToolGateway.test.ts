import { describe, expect, it, vi } from 'vitest';
import { CanvasToolGateway, CanvasToolGatewayError } from '../CanvasToolGateway';

describe('CanvasToolGateway', () => {
  it('does not execute a concurrent retry twice', async () => {
    const gateway = new CanvasToolGateway();
    let finish!: () => void;
    const apply = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    gateway.acquire('concurrent', 'project-1');
    const request = { runId: 'concurrent', projectId: 'project-1', operationId: 'same', ops: [], apply };
    const first = gateway.apply(request);
    const retry = gateway.apply(request);
    await Promise.resolve();
    expect(apply).toHaveBeenCalledTimes(1);
    finish();
    await first;
    expect(await retry).toBeNull();
  });

  it('rejects late operations and aborts an active apply after cancellation', async () => {
    const gateway = new CanvasToolGateway();
    gateway.acquire('cancelled', 'project-1');
    let signal!: AbortSignal;
    let finish!: () => void;
    const applying = gateway.apply({
      runId: 'cancelled', projectId: 'project-1', operationId: 'op', ops: [],
      apply: (_ops, currentSignal) => {
        signal = currentSignal;
        return new Promise<void>((resolve) => { finish = resolve; });
      },
    });
    await Promise.resolve();
    gateway.cancel('cancelled', 'project-1');
    expect(signal.aborted).toBe(true);
    expect(() => gateway.acquire('cancelled', 'project-1')).toThrow('cancelled');
    finish();
    await applying;
  });

  it('enforces one writer per project', () => {
    const gateway = new CanvasToolGateway();
    gateway.acquire('run-a', 'project-1');
    expect(() => gateway.acquire('run-b', 'project-1')).toThrow(CanvasToolGatewayError);
  });

  it('deduplicates operation ids after a successful canonical apply', async () => {
    const gateway = new CanvasToolGateway();
    const apply = vi.fn(async () => ({ created: 1 }));
    const request = {
      runId: 'run-a',
      projectId: 'project-1',
      operationId: 'op-1',
      ops: [{ name: 'create_text', args: { text: 'Title' } }],
      apply,
    };
    gateway.acquire(request.runId, request.projectId);
    expect(await gateway.apply(request)).toEqual({ created: 1 });
    expect(await gateway.apply(request)).toBeNull();
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
