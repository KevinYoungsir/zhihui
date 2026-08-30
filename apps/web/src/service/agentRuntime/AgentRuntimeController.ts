import type {
  AgentStepEvent,
  RunDesignAgentParams,
} from '@/components/editor/panels/agent/runDesignAgent';
import { AgentRuntimeBroker } from './AgentRuntimeBroker';
import { ApiRuntimeAdapter, createRunDesignAgentExecutor } from './ApiRuntimeAdapter';
import { CodexCliRuntimeAdapter } from './CodexCliRuntimeAdapter';
import { loadAgentRuntimePreference } from './preference';
import type {
  AgentRunEvent,
  AgentRunRequest,
  AgentRuntimePreference,
} from './types';

export type AgentRuntimeControllerOptions = {
  preference?: AgentRuntimePreference;
};

type ActiveRuntime = {
  runId: string;
  broker: AgentRuntimeBroker;
};

function nextRunId(): string {
  return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function cliPrompt(userMessage: string): string {
  return [
    userMessage.trim(),
    '',
    'Work on the current Recombyn project using the recombyn Canvas MCP tools.',
    'Use canonical canvas tools for every canvas change. Do not edit project files or run shell commands.',
    'When the requested canvas change is complete, briefly summarize the result.',
  ].join('\n');
}

function runtimeEventToAgentStep(event: AgentRunEvent): AgentStepEvent | null {
  if (event.type === 'message.delta') return { type: 'token', text: event.text };
  if (event.type === 'tool.call') {
    return {
      type: 'activity',
      id: event.callId || `${event.runId}-${event.timestamp}`,
      kind: 'tool',
      status: 'running',
      detail: event.tool,
    };
  }
  if (event.type === 'tool.result') {
    return {
      type: 'activity',
      id: event.callId || `${event.runId}-${event.timestamp}`,
      kind: 'tool',
      status: event.ok ? 'done' : 'error',
      detail: event.tool || event.error || 'Canvas tool',
    };
  }
  if (event.type === 'run.error') {
    return { type: 'error', code: event.code, message: event.message };
  }
  if (event.type === 'run.completed') {
    return { type: 'done', summary: event.summary || '', painted: true };
  }
  return null;
}

/** Component-facing facade: AgentDock never branches on API versus CLI. */
export class AgentRuntimeController {
  private active: ActiveRuntime | null = null;

  async run(
    params: RunDesignAgentParams,
    options: AgentRuntimeControllerOptions = {}
  ): Promise<void> {
    await this.cancel();
    const runId = nextRunId();
    const projectId = String(params.projectId || params.canvasId || '').trim();
    if (!projectId) throw new Error('Agent runtime requires a project id');
    const preference = options.preference || loadAgentRuntimePreference();
    const request: AgentRunRequest = {
      runId,
      projectId,
      prompt: preference.mode === 'cli' ? cliPrompt(params.userMessage) : params.userMessage,
      selectedObjectIds: [],
      runtime: preference.mode,
      sessionId: params.sessionId || undefined,
      locale: params.locale || undefined,
      model: params.model,
    };
    const api = new ApiRuntimeAdapter(
      createRunDesignAgentExecutor((runtimeRequest, signal, onEvent) => ({
        ...params,
        runtimeRunId: runtimeRequest.runId,
        signal,
        onEvent: (event) => {
          params.onEvent(event);
          onEvent(event);
        },
      }))
    );
    const cli = new CodexCliRuntimeAdapter();
    const broker = new AgentRuntimeBroker([api, cli]);
    this.active = { runId, broker };
    const unsubscribe = broker.subscribe((event) => {
      if (event.runtime !== 'cli' || event.runId !== runId) return;
      const step = runtimeEventToAgentStep(event);
      if (step) params.onEvent(step);
    });
    const onAbort = () => { void broker.cancelRun(runId); };
    params.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await broker.startRun(request, preference);
    } finally {
      params.signal?.removeEventListener('abort', onAbort);
      unsubscribe();
      broker.dispose();
      await cli.dispose();
      if (this.active?.runId === runId) this.active = null;
    }
  }

  async cancel(): Promise<void> {
    const active = this.active;
    if (!active) return;
    await active.broker.cancelRun(active.runId);
  }
}
