import type { AgentRunEvent, AgentRunEventListener } from './types';

export class AgentRunEventBus {
  private readonly listeners = new Set<AgentRunEventListener>();

  emit(event: AgentRunEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: AgentRunEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
