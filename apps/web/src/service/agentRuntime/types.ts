import type { AgentToolOp } from '@/components/editor/panels/agent/toolOpsContract';

export type AgentRuntimeMode = 'api' | 'cli';

export type AgentRuntimePreference = {
  mode: AgentRuntimeMode;
  cliAgentId?: 'codex';
};

export type CliAgentCapabilities = {
  conversation: boolean;
  canvasTools: boolean;
  imageGeneration: boolean;
  streamingJsonl: boolean;
  cancellation: boolean;
};

export type CliAgentDescriptor = {
  id: 'codex';
  displayName: string;
  executableName: 'codex';
  capabilities: CliAgentCapabilities;
};

export type AgentRunRequest = {
  runId: string;
  projectId: string;
  prompt: string;
  sessionId?: string;
  locale?: string;
  model?: string | null;
  metadata?: Record<string, unknown>;
};

type AgentRunEventBase = {
  runId: string;
  projectId: string;
  runtime: AgentRuntimeMode;
  timestamp: number;
};

export type AgentRunEvent =
  | (AgentRunEventBase & { type: 'run.started' })
  | (AgentRunEventBase & { type: 'text.delta'; text: string })
  | (AgentRunEventBase & {
      type: 'progress';
      phase: string;
      payload?: Record<string, unknown>;
    })
  | (AgentRunEventBase & {
      type: 'tool.call';
      callId?: string;
      tool: string;
      arguments: Record<string, unknown>;
    })
  | (AgentRunEventBase & {
      type: 'tool.result';
      callId?: string;
      tool?: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    })
  | (AgentRunEventBase & {
      type: 'canvas.ops';
      operationId: string;
      ops: AgentToolOp[];
    })
  | (AgentRunEventBase & {
      type: 'run.error';
      code: string;
      message: string;
      retryable?: boolean;
    })
  | (AgentRunEventBase & { type: 'run.completed'; summary?: string })
  | (AgentRunEventBase & { type: 'run.cancelled'; reason?: string });

export type AgentRunEventListener = (event: AgentRunEvent) => void;

export type AgentRuntimeProbe = {
  available: boolean;
  authenticated?: boolean;
  version?: string;
  reason?: 'not_desktop' | 'not_installed' | 'login_required' | 'unavailable';
};

export interface AgentRuntimeAdapter {
  readonly mode: AgentRuntimeMode;
  startRun(request: AgentRunRequest): Promise<void>;
  cancelRun(runId: string): Promise<void>;
  subscribe(listener: AgentRunEventListener): () => void;
  probe(): Promise<AgentRuntimeProbe>;
}

export const CODEX_CLI_AGENT: CliAgentDescriptor = {
  id: 'codex',
  displayName: 'Codex CLI',
  executableName: 'codex',
  capabilities: {
    conversation: true,
    canvasTools: true,
    imageGeneration: false,
    streamingJsonl: true,
    cancellation: true,
  },
};
