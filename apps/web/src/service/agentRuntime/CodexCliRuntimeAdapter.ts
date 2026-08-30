import {
  mcpCanvasCreateRunGrant,
  mcpCanvasRevokeRunGrant,
  type McpRunGrant,
} from '@/service/mcpCanvas';
import { AgentRunEventBus } from './eventBus';
import {
  codexDesktopBridge,
  desktopApiOrigin,
  type CodexDesktopBridge,
  type CodexNativeEvent,
} from './tauriBridge';
import type {
  AgentRunEvent,
  AgentRunEventListener,
  AgentRunRequest,
  AgentRuntimeAdapter,
  AgentRuntimeProbe,
} from './types';

export type CodexRunGrantService = {
  create(runId: string, projectId: string): Promise<McpRunGrant>;
  revoke(runId: string): Promise<void>;
};

const defaultGrantService: CodexRunGrantService = {
  create: mcpCanvasCreateRunGrant,
  revoke: mcpCanvasRevokeRunGrant,
};

type ActiveCodexRun = {
  request: AgentRunRequest;
  grant: McpRunGrant;
  revoked: boolean;
  settle: () => void;
};

export class CodexCliRuntimeAdapter implements AgentRuntimeAdapter {
  readonly mode = 'cli' as const;
  private readonly events = new AgentRunEventBus();
  private readonly runs = new Map<string, ActiveCodexRun>();
  private unlisten: (() => void) | null = null;

  constructor(
    private readonly bridge: CodexDesktopBridge = codexDesktopBridge,
    private readonly grants: CodexRunGrantService = defaultGrantService
  ) {}

  subscribe(listener: AgentRunEventListener): () => void {
    return this.events.subscribe(listener);
  }

  probe(): Promise<AgentRuntimeProbe> {
    return this.bridge.discover();
  }

  async startRun(request: AgentRunRequest): Promise<void> {
    if (this.runs.has(request.runId)) throw new Error(`Codex run already active: ${request.runId}`);
    const probe = await this.probe();
    if (!probe.available || probe.authenticated === false) {
      this.events.emit(this.event(request, {
        type: 'run.error',
        code: probe.reason === 'not_desktop' ? 'desktop_required' : probe.authenticated === false ? 'codex_login_required' : 'codex_not_installed',
        message: probe.reason === 'not_desktop' ? 'Codex CLI requires the desktop app' : probe.authenticated === false ? 'Codex CLI login is required' : 'Codex CLI is not installed',
      }));
      return;
    }
    await this.ensureListener();
    const grant = await this.grants.create(request.runId, request.projectId);
    let settle = () => undefined;
    const terminal = new Promise<void>((resolve) => { settle = resolve; });
    this.runs.set(request.runId, { request, grant, revoked: false, settle });
    this.events.emit(this.event(request, { type: 'run.started' }));
    try {
      await this.bridge.start({
        runId: request.runId,
        projectId: request.projectId,
        prompt: request.prompt,
        apiOrigin: desktopApiOrigin(),
        grantToken: grant.grant,
      });
    } catch (error) {
      await this.finalize(request.runId);
      this.events.emit(this.event(request, { type: 'run.error', code: 'codex_start_failed', message: error instanceof Error ? error.message : String(error) }));
      return;
    }
    await terminal;
  }

  async cancelRun(runId: string): Promise<void> {
    const active = this.runs.get(runId);
    if (!active) return;
    try {
      await this.bridge.cancel(runId);
    } finally {
      await this.revoke(active);
      this.events.emit(this.event(active.request, { type: 'run.cancelled', reason: 'cancelled' }));
      await this.finalize(runId);
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((runId) => this.cancelRun(runId)));
    this.unlisten?.();
    this.unlisten = null;
  }

  private async ensureListener(): Promise<void> {
    if (this.unlisten) return;
    this.unlisten = await this.bridge.listen((event) => this.onNativeEvent(event));
  }

  private onNativeEvent(native: CodexNativeEvent): void {
    const active = this.runs.get(native.runId);
    if (!active) return;
    const { request } = active;
    let event: AgentRunEvent;
    if (native.kind === 'text.delta') {
      event = this.event(request, { type: 'message.delta', text: native.text || '' });
    } else if (native.kind === 'tool.call') {
      event = this.event(request, { type: 'tool.call', callId: native.callId, tool: native.tool || 'canvas', arguments: {} });
    } else if (native.kind === 'tool.result') {
      event = this.event(request, { type: 'tool.result', callId: native.callId, tool: native.tool, ok: native.ok !== false, error: native.ok === false ? native.code : undefined });
    } else if (native.kind === 'run.completed') {
      event = this.event(request, { type: 'run.completed' });
    } else if (native.kind === 'run.cancelled') {
      event = this.event(request, { type: 'run.cancelled', reason: native.code || 'cancelled' });
    } else if (native.kind === 'run.error') {
      event = this.event(request, { type: 'run.error', code: native.code || 'codex_runtime_failed', message: native.text || 'Codex CLI failed' });
    } else {
      event = this.event(request, { type: 'activity', phase: native.phase || native.kind, detail: native.text });
    }
    this.events.emit(event);
    if (event.type === 'run.completed' || event.type === 'run.cancelled' || event.type === 'run.error') {
      void this.finalize(request.runId);
    }
  }

  private async revoke(active: ActiveCodexRun): Promise<void> {
    if (active.revoked) return;
    active.revoked = true;
    try {
      await this.grants.revoke(active.request.runId);
    } catch {
      // Grant TTL remains the fail-safe if the API is unavailable during cleanup.
    }
  }

  private async finalize(runId: string): Promise<void> {
    const active = this.runs.get(runId);
    if (!active) return;
    await this.revoke(active);
    this.runs.delete(runId);
    active.settle();
  }

  private event<T extends Omit<AgentRunEvent, 'runId' | 'projectId' | 'runtime' | 'timestamp'>>(
    request: AgentRunRequest,
    event: T
  ): AgentRunEvent {
    return { ...event, runId: request.runId, projectId: request.projectId, runtime: this.mode, timestamp: Date.now() } as AgentRunEvent;
  }
}
