import type { AgentToolOp } from '@/components/editor/panels/agent/toolOpsContract';

export type CanvasToolGatewayApplyRequest<T> = {
  runId: string;
  projectId: string;
  operationId: string;
  ops: AgentToolOp[];
  apply: (ops: AgentToolOp[]) => Promise<T>;
};

export class CanvasToolGatewayError extends Error {
  constructor(
    readonly code: 'canvas_busy' | 'run_not_owner' | 'invalid_operation',
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

  acquire(runId: string, projectId: string): void {
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
    if (!request.operationId.trim()) {
      throw new CanvasToolGatewayError('invalid_operation', 'operationId is required');
    }
    if (this.owners.get(request.projectId) !== request.runId) {
      throw new CanvasToolGatewayError(
        'run_not_owner',
        `Agent run ${request.runId} does not own project ${request.projectId}`
      );
    }
    const key = `${request.projectId}:${request.runId}:${request.operationId}`;
    if (this.appliedOperationIds.has(key)) return null;
    const result = await request.apply(request.ops);
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
