import {
  runDesignAgent,
  type AgentStepEvent,
  type RunDesignAgentParams,
} from '@/components/editor/panels/agent/runDesignAgent';
import { AgentRunEventBus } from './eventBus';
import type {
  AgentRunEvent,
  AgentRunEventListener,
  AgentRunRequest,
  AgentRuntimeAdapter,
  AgentRuntimeProbe,
} from './types';

export type ApiRuntimeExecutionContext = {
  signal: AbortSignal;
  emit: (event: AgentRunEvent) => void;
};

export type ApiRuntimeExecutor = (
  request: AgentRunRequest,
  context: ApiRuntimeExecutionContext
) => Promise<void>;

export class ApiRuntimeAdapter implements AgentRuntimeAdapter {
  readonly mode = 'api' as const;
  private readonly events = new AgentRunEventBus();
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly execute: ApiRuntimeExecutor) {}

  subscribe(listener: AgentRunEventListener): () => void {
    return this.events.subscribe(listener);
  }

  async probe(): Promise<AgentRuntimeProbe> {
    return { available: true };
  }

  async startRun(request: AgentRunRequest): Promise<void> {
    if (this.controllers.has(request.runId)) {
      throw new Error(`API Agent run already active: ${request.runId}`);
    }
    const controller = new AbortController();
    this.controllers.set(request.runId, controller);
    let terminal = false;
    const emit = (event: AgentRunEvent) => {
      if (
        event.type === 'run.completed' ||
        event.type === 'run.cancelled' ||
        event.type === 'run.error'
      ) {
        terminal = true;
      }
      this.events.emit(event);
    };
    emit(this.event(request, { type: 'run.started' }));
    try {
      await this.execute(request, { signal: controller.signal, emit });
      if (!terminal && !controller.signal.aborted) {
        emit(this.event(request, { type: 'run.completed' }));
      }
    } catch (error) {
      if (!terminal && controller.signal.aborted) {
        emit(this.event(request, { type: 'run.cancelled', reason: 'cancelled' }));
      } else if (!terminal) {
        emit(
          this.event(request, {
            type: 'run.error',
            code: 'api_runtime_failed',
            message: error instanceof Error ? error.message : String(error),
          })
        );
      }
    } finally {
      this.controllers.delete(request.runId);
    }
  }

  async cancelRun(runId: string): Promise<void> {
    this.controllers.get(runId)?.abort();
  }

  private event<T extends Omit<AgentRunEvent, 'runId' | 'projectId' | 'runtime' | 'timestamp'>>(
    request: AgentRunRequest,
    event: T
  ): AgentRunEvent {
    return {
      ...event,
      runId: request.runId,
      projectId: request.projectId,
      runtime: this.mode,
      timestamp: Date.now(),
    } as AgentRunEvent;
  }
}

export type RunDesignAgentParamsFactory = (
  request: AgentRunRequest,
  signal: AbortSignal,
  onEvent: (event: AgentStepEvent) => void
) => RunDesignAgentParams;

/** API adapter seam: the existing `/design/run` implementation remains the execution kernel. */
export function createRunDesignAgentExecutor(
  createParams: RunDesignAgentParamsFactory
): ApiRuntimeExecutor {
  return async (request, context) => {
    await runDesignAgent(
      createParams(request, context.signal, (step) => {
        if (step.type === 'token' && step.text) {
          context.emit({
            type: 'text.delta',
            text: step.text,
            runId: request.runId,
            projectId: request.projectId,
            runtime: 'api',
            timestamp: Date.now(),
          });
        } else if (step.type === 'error') {
          context.emit({
            type: 'run.error',
            code: step.code || 'design_agent_failed',
            message: step.message || step.code || 'Design Agent failed',
            retryable: step.resumable,
            runId: request.runId,
            projectId: request.projectId,
            runtime: 'api',
            timestamp: Date.now(),
          });
        } else {
          context.emit({
            type: 'progress',
            phase: step.type,
            payload: step as unknown as Record<string, unknown>,
            runId: request.runId,
            projectId: request.projectId,
            runtime: 'api',
            timestamp: Date.now(),
          });
        }
      })
    );
  };
}
