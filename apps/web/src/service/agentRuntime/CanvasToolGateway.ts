import type { AgentToolOp } from '@/components/editor/panels/agent/toolOpsContract';

export type CanvasToolGatewayApplyRequest<T> = {
  runId: string;
  projectId: string;
  operationId: string;
  ops: AgentToolOp[];
  apply: (ops: AgentToolOp[], signal: AbortSignal) => Promise<T>;
};

export class CanvasToolGatewayError extends Error {
  constructor(
    readonly code: 'canvas_busy' | 'run_not_owner' | 'invalid_operation' | 'run_cancelled',
    message: string
  ) {
    super(message);
    this.name = 'CanvasToolGatewayError';
  }
}

/** Single-writer and operation-id boundary shared by API and CLI runtimes. */
export class CanvasToolGateway {
  private readonly owners = new Map<string, string>();
  private readonly appliedOperationIds = new Set<string>();
  private readonly appliedOrder: string[] = [];
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly controllers = new Map<string, Set<AbortController>>();
  // Run IDs are never reused within this editor session. Do not evict cancellation
  // tombstones while an already-fetched MCP batch could still be delivered.
  private readonly cancelled = new Set<string>();

  private runKey(runId: string, projectId: string): string {
    return JSON.stringify([projectId, runId]);
  }

  isCancelled(runId: string, projectId: string): boolean {
    return this.cancelled.has(this.runKey(runId, projectId));
  }

  cancel(runId: string, projectId: string): void {
    const key = this.runKey(runId, projectId);
    this.cancelled.add(key);
    for (const controller of this.controllers.get(key) || []) controller.abort();
  }

  private requireNotCancelled(runId: string, projectId: string): void {
    if (this.isCancelled(runId, projectId)) {
      throw new CanvasToolGatewayError('run_cancelled', 'Agent run was cancelled');
    }
  }

  acquire(runId: string, projectId: string): void {
    this.requireNotCancelled(runId, projectId);
    const owner = this.owners.get(projectId);
    if (owner && owner !== runId) {
      throw new CanvasToolGatewayError(
        'canvas_busy',
        `Project ${projectId} is already owned by Agent run ${owner}`
      );
    }
    this.owners.set(projectId, runId);
  }

  release(runId: string, projectId: string): void {
    if (this.owners.get(projectId) === runId) this.owners.delete(projectId);
  }

  async apply<T>(request: CanvasToolGatewayApplyRequest<T>): Promise<T | null> {
    this.requireNotCancelled(request.runId, request.projectId);
    if (!request.operationId.trim()) {
      throw new CanvasToolGatewayError('invalid_operation', 'operationId is required');
    }
    if (this.owners.get(request.projectId) !== request.runId) {
      throw new CanvasToolGatewayError(
        'run_not_owner',
        `Agent run ${request.runId} does not own project ${request.projectId}`
      );
    }
    const key = JSON.stringify([request.projectId, request.runId, request.operationId]);
    if (this.appliedOperationIds.has(key)) return null;
    const pending = this.pending.get(key);
    if (pending) {
      await pending;
      return null;
    }
    const runKey = this.runKey(request.runId, request.projectId);
    const controller = new AbortController();
    const controllers = this.controllers.get(runKey) || new Set<AbortController>();
    controllers.add(controller);
    this.controllers.set(runKey, controllers);
    // Reserve the ID before invoking even a synchronous/reentrant executor.
    const operation = Promise.resolve().then(() => {
      this.requireNotCancelled(request.runId, request.projectId);
      return request.apply(request.ops, controller.signal);
    });
    this.pending.set(key, operation);
    let result: T;
    try {
      result = await operation;
    } finally {
      this.pending.delete(key);
      controllers.delete(controller);
      if (!controllers.size) this.controllers.delete(runKey);
    }
    this.appliedOperationIds.add(key);
    this.appliedOrder.push(key);
    while (this.appliedOrder.length > 2048) {
      const oldest = this.appliedOrder.shift();
      if (oldest) this.appliedOperationIds.delete(oldest);
    }
    return result;
  }
}

export const canvasToolGateway = new CanvasToolGateway();
