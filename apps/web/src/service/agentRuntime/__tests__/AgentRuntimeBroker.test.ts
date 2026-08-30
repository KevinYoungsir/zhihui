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
});
