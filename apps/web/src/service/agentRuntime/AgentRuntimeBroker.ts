import { AgentRunEventBus } from './eventBus';
import type {
  AgentRunEventListener,
  AgentRunRequest,
  AgentRuntimeAdapter,
  AgentRuntimeMode,
  AgentRuntimePreference,
  AgentRuntimeProbe,
} from './types';

export class AgentRuntimeBroker {
  private readonly adapters = new Map<AgentRuntimeMode, AgentRuntimeAdapter>();
  private readonly activeRuns = new Map<string, AgentRuntimeAdapter>();
  private readonly events = new AgentRunEventBus();
  private readonly unsubscriptions: Array<() => void> = [];

  constructor(adapters: AgentRuntimeAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.mode)) {
        throw new Error(`Duplicate Agent runtime adapter: ${adapter.mode}`);
      }
      this.adapters.set(adapter.mode, adapter);
      this.unsubscriptions.push(
        adapter.subscribe((event) => {
          this.events.emit(event);
          if (
            event.type === 'run.completed' ||
            event.type === 'run.cancelled' ||
            event.type === 'run.error'
          ) {
            this.activeRuns.delete(event.runId);
          }
        })
      );
    }
  }

  subscribe(listener: AgentRunEventListener): () => void {
    return this.events.subscribe(listener);
  }

  async probe(mode: AgentRuntimeMode): Promise<AgentRuntimeProbe> {
    const adapter = this.requireAdapter(mode);
    return adapter.probe();
  }

  async startRun(
    request: AgentRunRequest,
    preference: AgentRuntimePreference = { mode: 'api' }
  ): Promise<void> {
    if (this.activeRuns.has(request.runId)) {
      throw new Error(`Agent run already active: ${request.runId}`);
    }
    const adapter = this.requireAdapter(preference.mode);
    this.activeRuns.set(request.runId, adapter);
    try {
      await adapter.startRun(request);
    } catch (error) {
      this.activeRuns.delete(request.runId);
      throw error;
    }
  }

  async cancelRun(runId: string): Promise<void> {
    const adapter = this.activeRuns.get(runId);
    if (!adapter) return;
    await adapter.cancelRun(runId);
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscriptions.splice(0)) unsubscribe();
    this.activeRuns.clear();
  }

  private requireAdapter(mode: AgentRuntimeMode): AgentRuntimeAdapter {
    const adapter = this.adapters.get(mode);
    if (!adapter) throw new Error(`Agent runtime is not configured: ${mode}`);
    return adapter;
  }
}
