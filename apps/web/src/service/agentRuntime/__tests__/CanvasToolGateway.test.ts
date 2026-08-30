import { describe, expect, it, vi } from 'vitest';
import { CanvasToolGateway, CanvasToolGatewayError } from '../CanvasToolGateway';

describe('CanvasToolGateway', () => {
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
