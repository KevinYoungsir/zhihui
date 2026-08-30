import { describe, expect, it, vi } from 'vitest';
import { AgentRuntimeBroker } from '../AgentRuntimeBroker';
import { AgentRunEventBus } from '../eventBus';
import type {
  AgentRunEventListener,
  AgentRunRequest,
  AgentRuntimeAdapter,
  AgentRuntimeMode,
} from '../types';

function adapter(mode: AgentRuntimeMode): AgentRuntimeAdapter & { startRun: ReturnType<typeof vi.fn> } {
  const bus = new AgentRunEventBus();
  return {
    mode,
    startRun: vi.fn(async (request: AgentRunRequest) => {
      bus.emit({
        type: 'run.completed',
        runId: request.runId,
        projectId: request.projectId,
        runtime: mode,
        timestamp: Date.now(),
      });
    }),
    cancelRun: vi.fn(async () => undefined),
    subscribe: (listener: AgentRunEventListener) => bus.subscribe(listener),
    probe: vi.fn(async () => ({ available: true })),
  };
}

const request: AgentRunRequest = {
  runId: 'run-1',
  projectId: 'project-1',
  prompt: 'create title text',
  selectedObjectIds: [],
  runtime: 'api',
};

describe('AgentRuntimeBroker', () => {
  it('defaults to the existing API runtime', async () => {
    const api = adapter('api');
    const cli = adapter('cli');
    const broker = new AgentRuntimeBroker([api, cli]);
    await broker.startRun(request);
    expect(api.startRun).toHaveBeenCalledWith(request);
    expect(cli.startRun).not.toHaveBeenCalled();
  });

  it('selects Codex CLI only for an explicit cli preference', async () => {
    const api = adapter('api');
    const cli = adapter('cli');
    const broker = new AgentRuntimeBroker([api, cli]);
    await broker.startRun(request, { mode: 'cli', cliAgentId: 'codex' });
    expect(cli.startRun).toHaveBeenCalledWith(request);
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it('reports an unavailable runtime configuration', async () => {
    const broker = new AgentRuntimeBroker([adapter('api')]);
    await expect(
      broker.startRun(
        { ...request, runtime: 'cli' },
        { mode: 'cli', cliAgentId: 'codex' }
      )
    ).rejects.toThrow('Agent runtime is not configured: cli');
  });

  it('forwards cancel to the adapter that owns the run', async () => {
    const bus = new AgentRunEventBus();
    let settle = () => undefined;
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    const api: AgentRuntimeAdapter = {
      mode: 'api',
      startRun: vi.fn(() => pending),
      cancelRun: vi.fn(async () => { settle(); }),
      subscribe: (listener) => bus.subscribe(listener),
      probe: vi.fn(async () => ({ available: true })),
    };
    const broker = new AgentRuntimeBroker([api]);
    const running = broker.startRun(request);
    await Promise.resolve();
    await broker.cancelRun(request.runId);
    await running;
    expect(api.cancelRun).toHaveBeenCalledWith(request.runId);
  });
});
