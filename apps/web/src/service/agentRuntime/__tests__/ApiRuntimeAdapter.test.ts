import { describe, expect, it, vi } from 'vitest';
import { ApiRuntimeAdapter } from '../ApiRuntimeAdapter';

const request = {
  runId: 'api-run-1',
  projectId: 'project-1',
  prompt: 'create title',
  selectedObjectIds: [],
  runtime: 'api' as const,
};

describe('ApiRuntimeAdapter', () => {
  it('emits cancellation when an aborted executor resolves normally', async () => {
    const adapter = new ApiRuntimeAdapter(async (_request, context) => {
      await new Promise<void>((resolve) => {
        context.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const events: string[] = [];
    adapter.subscribe((event) => events.push(event.type));
    const running = adapter.startRun(request);
    await adapter.cancelRun(request.runId);
    await running;
    expect(events).toEqual(['run.started', 'run.cancelled']);
  });

  it('normalizes executor failures', async () => {
    const adapter = new ApiRuntimeAdapter(async () => { throw new Error('invalid API key'); });
    const events: string[] = [];
    adapter.subscribe((event) => events.push(event.type));
    await adapter.startRun(request);
    expect(events).toEqual(['run.started', 'run.error']);
  });

  it('cancels an in-flight API run through AbortSignal', async () => {
    const aborted = vi.fn();
    const adapter = new ApiRuntimeAdapter(async (_request, context) => {
      await new Promise<void>((resolve, reject) => {
        context.signal.addEventListener('abort', () => {
          aborted();
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    });
    const events: string[] = [];
    adapter.subscribe((event) => events.push(event.type));
    const running = adapter.startRun(request);
    await adapter.cancelRun(request.runId);
    await running;
    expect(aborted).toHaveBeenCalledOnce();
    expect(events).toContain('run.cancelled');
  });
});
