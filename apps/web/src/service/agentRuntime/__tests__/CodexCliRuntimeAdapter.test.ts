import { describe, expect, it, vi } from 'vitest';
import { CodexCliRuntimeAdapter, type CodexRunGrantService } from '../CodexCliRuntimeAdapter';
import type { AgentRunEvent, AgentRunRequest, AgentRuntimeProbe } from '../types';
import type { McpRunGrant } from '@/service/mcpCanvas';
import type { CodexDesktopBridge, CodexNativeEvent } from '../tauriBridge';

function harness() {
  let listener: ((event: CodexNativeEvent) => void) | null = null;
  const bridge: CodexDesktopBridge = {
    discover: vi.fn(async () => ({ available: true, authenticated: true, version: 'codex 1.0' })),
    start: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    listen: vi.fn(async (next) => { listener = next; return () => { listener = null; }; }),
  };
  const grants = {
    create: vi.fn(async (runId: string, projectId: string) => ({ grant: 'mcp_run_secret', runId, projectId, allowedTools: ['create_text'], expiresIn: 180 })),
    revoke: vi.fn(async () => undefined),
  };
  return { bridge, grants, emit: (event: CodexNativeEvent) => listener?.(event) };
}

describe('CodexCliRuntimeAdapter', () => {
  it('does not start a process when cancelled during discovery', async () => {
    const { bridge, grants } = harness();
    let finish!: (probe: { available: boolean; authenticated: boolean }) => void;
    vi.mocked(bridge.discover).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const adapter = new CodexCliRuntimeAdapter(bridge, grants);
    const running = adapter.startRun({ runId: 'cancel-discovery', projectId: 'project-1', prompt: 'title', selectedObjectIds: [], runtime: 'cli' });
    await adapter.cancelRun('cancel-discovery');
    finish({ available: true, authenticated: true });
    await running;
    expect(grants.create).not.toHaveBeenCalled();
    expect(bridge.start).not.toHaveBeenCalled();
  });

  it('revokes a grant arriving after cancellation without starting Codex', async () => {
    const { bridge, grants } = harness();
    let finish!: () => void;
    vi.mocked(grants.create).mockImplementation((runId, projectId) => new Promise((resolve) => {
      finish = () => resolve({ grant: 'mcp_run_fixture', runId, projectId, allowedTools: ['create_text'], expiresIn: 180 });
    }));
    const adapter = new CodexCliRuntimeAdapter(bridge, grants);
    const running = adapter.startRun({ runId: 'cancel-grant', projectId: 'project-1', prompt: 'title', selectedObjectIds: [], runtime: 'cli' });
    await vi.waitFor(() => expect(grants.create).toHaveBeenCalled());
    await adapter.cancelRun('cancel-grant');
    finish();
    await running;
    expect(grants.revoke).toHaveBeenCalledWith('cancel-grant');
    expect(bridge.start).not.toHaveBeenCalled();
  });

  it('mints a scoped grant and revokes it on completion', async () => {
    const { bridge, grants, emit } = harness();
    const adapter = new CodexCliRuntimeAdapter(bridge, grants);
    const running = adapter.startRun({ runId: 'run-1', projectId: 'project-1', prompt: 'create title', selectedObjectIds: [], runtime: 'cli' });
    await vi.waitFor(() => expect(bridge.start).toHaveBeenCalled());
    expect(grants.create).toHaveBeenCalledWith('run-1', 'project-1');
    expect(bridge.start).toHaveBeenCalledWith(expect.objectContaining({ grantToken: 'mcp_run_secret' }));
    emit({ runId: 'run-1', kind: 'run.completed' });
    await running;
    await vi.waitFor(() => expect(grants.revoke).toHaveBeenCalledWith('run-1'));
  });

  it('kills the desktop run and revokes access on cancel', async () => {
    const { bridge, grants } = harness();
    const adapter = new CodexCliRuntimeAdapter(bridge, grants);
    const running = adapter.startRun({ runId: 'run-2', projectId: 'project-1', prompt: 'create title', selectedObjectIds: [], runtime: 'cli' });
    await vi.waitFor(() => expect(bridge.start).toHaveBeenCalled());
    await adapter.cancelRun('run-2');
    await running;
    expect(bridge.cancel).toHaveBeenCalledWith('run-2');
    expect(grants.revoke).toHaveBeenCalledWith('run-2');
  });

  it('reports a missing CLI without minting a grant', async () => {
    const { bridge, grants } = harness();
    vi.mocked(bridge.discover).mockResolvedValue({ available: false, reason: 'not_installed' });
    const adapter = new CodexCliRuntimeAdapter(bridge, grants);
    const events: string[] = [];
    adapter.subscribe((event) => events.push(event.type));
    await adapter.startRun({ runId: 'run-3', projectId: 'project-1', prompt: 'create title', selectedObjectIds: [], runtime: 'cli' });
    expect(events).toContain('run.error');
    expect(grants.create).not.toHaveBeenCalled();
    expect(bridge.start).not.toHaveBeenCalled();
  });

  it('reports login-required without minting a grant', async () => {
    const { bridge, grants } = harness();
    vi.mocked(bridge.discover).mockResolvedValue({ available: true, authenticated: false, reason: 'login_required' });
    const adapter = new CodexCliRuntimeAdapter(bridge, grants);
    const errors: string[] = [];
    adapter.subscribe((event) => {
      if (event.type === 'run.error') errors.push(event.code);
    });
    await adapter.startRun({ runId: 'run-4', projectId: 'project-1', prompt: 'create title', selectedObjectIds: [], runtime: 'cli' });
    expect(errors).toContain('codex_login_required');
    expect(grants.create).not.toHaveBeenCalled();
  });

  it('revokes the grant when the Codex process reports a crash', async () => {
    const { bridge, grants, emit } = harness();
    const adapter = new CodexCliRuntimeAdapter(bridge, grants);
    const running = adapter.startRun({ runId: 'run-5', projectId: 'project-1', prompt: 'create title', selectedObjectIds: [], runtime: 'cli' });
    await vi.waitFor(() => expect(bridge.start).toHaveBeenCalled());
    emit({ runId: 'run-5', kind: 'run.error', code: 'codex_process_failed' });
    await running;
    expect(grants.revoke).toHaveBeenCalledWith('run-5');
  });

  it('keeps cancellation terminal when Tauri start rejects after Stop', async () => {
    const { bridge, grants } = harness();
    const startDeferred = deferred<void>();
    vi.mocked(bridge.start).mockReturnValue(startDeferred.promise);
    const adapter = new CodexCliRuntimeAdapter(bridge, grants);
    const events: AgentRunEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    const start = adapter.startRun({ runId: 'cancel-start-race', projectId: 'project-1', prompt: 'create title', selectedObjectIds: [], runtime: 'cli' });
    await vi.waitFor(() => expect(bridge.start).toHaveBeenCalled());
    await adapter.cancelRun('cancel-start-race');
    startDeferred.reject(new Error('cancelled by native start gate'));
    await start;

    expect(events.map((event) => event.type)).toEqual(['run.started', 'run.cancelled']);
    expect(grants.revoke).toHaveBeenCalledWith('cancel-start-race');
    expect(bridge.cancel).toHaveBeenCalledWith('cancel-start-race');
  });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function lifecycleRequest(runId: string): AgentRunRequest {
  return {
    runId,
    projectId: 'project-1',
    prompt: 'create a title',
    selectedObjectIds: [],
    runtime: 'cli',
  };
}

function lifecycleGrant(runId: string): McpRunGrant {
  return {
    grant: `grant-${runId}`,
    runId,
    projectId: 'project-1',
    allowedTools: ['create_text'],
    expiresIn: 600,
  };
}

function lifecycleHarness() {
  let listener: ((event: CodexNativeEvent) => void) | null = null;
  const bridge: CodexDesktopBridge = {
    discover: vi.fn(async (): Promise<AgentRuntimeProbe> => ({ available: true, authenticated: true })),
    start: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    listen: vi.fn(async (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    }),
  };
  const grants: CodexRunGrantService = {
    create: vi.fn(async (runId) => lifecycleGrant(runId)),
    revoke: vi.fn(async () => undefined),
  };
  const events: AgentRunEvent[] = [];
  const adapter = new CodexCliRuntimeAdapter(bridge, grants);
  adapter.subscribe((event) => events.push(event));
  return {
    adapter,
    bridge,
    grants,
    events,
    emit: (event: CodexNativeEvent) => listener?.(event),
  };
}

describe('CodexCliRuntimeAdapter closeout lifecycle', () => {
  it('emits cancellation when probe preparation is interrupted', async () => {
    const h = lifecycleHarness();
    const probe = deferred<AgentRuntimeProbe>();
    vi.mocked(h.bridge.discover).mockReturnValue(probe.promise);

    const start = h.adapter.startRun(lifecycleRequest('prepare-probe'));
    await vi.waitFor(() => expect(h.bridge.discover).toHaveBeenCalledOnce());
    await h.adapter.cancelRun('prepare-probe');
    probe.resolve({ available: true, authenticated: true });
    await start;

    expect(h.grants.create).not.toHaveBeenCalled();
    expect(h.bridge.start).not.toHaveBeenCalled();
    expect(h.events[h.events.length - 1]).toMatchObject({ type: 'run.cancelled', runId: 'prepare-probe' });
  });

  it('revokes a grant when cancellation wins before Codex spawn', async () => {
    const h = lifecycleHarness();
    const pendingGrant = deferred<McpRunGrant>();
    vi.mocked(h.grants.create).mockReturnValue(pendingGrant.promise);

    const start = h.adapter.startRun(lifecycleRequest('prepare-grant'));
    await vi.waitFor(() => expect(h.grants.create).toHaveBeenCalledWith('prepare-grant', 'project-1'));
    await h.adapter.cancelRun('prepare-grant');
    pendingGrant.resolve(lifecycleGrant('prepare-grant'));
    await start;

    expect(h.bridge.start).not.toHaveBeenCalled();
    expect(h.grants.revoke).toHaveBeenCalledWith('prepare-grant');
    expect(h.events[h.events.length - 1]).toMatchObject({ type: 'run.cancelled', runId: 'prepare-grant' });
  });

  it('revokes the grant and emits a controlled error when Codex spawn fails', async () => {
    const h = lifecycleHarness();
    vi.mocked(h.bridge.start).mockRejectedValue(new Error('spawn failed'));

    await h.adapter.startRun(lifecycleRequest('spawn-error'));

    expect(h.grants.revoke).toHaveBeenCalledWith('spawn-error');
    expect(h.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'run.started', runId: 'spawn-error' }),
      expect.objectContaining({ type: 'run.error', code: 'codex_start_failed', runId: 'spawn-error' }),
    ]));
  });

  it('revokes the grant and settles on a native runtime error', async () => {
    const h = lifecycleHarness();
    const start = h.adapter.startRun(lifecycleRequest('native-error'));
    await vi.waitFor(() => expect(h.bridge.start).toHaveBeenCalledOnce());
    h.emit({ runId: 'native-error', kind: 'run.error', code: 'process_timeout', text: 'timed out' });
    await start;

    expect(h.grants.revoke).toHaveBeenCalledWith('native-error');
    expect(h.events[h.events.length - 1]).toMatchObject({ type: 'run.error', runId: 'native-error', code: 'process_timeout' });
  });

  it('cancels an active run and ignores late native events', async () => {
    const h = lifecycleHarness();
    const start = h.adapter.startRun(lifecycleRequest('active-cancel'));
    await vi.waitFor(() => expect(h.bridge.start).toHaveBeenCalledOnce());
    await h.adapter.cancelRun('active-cancel');
    await start;
    const eventCount = h.events.length;

    h.emit({ runId: 'active-cancel', kind: 'tool.result', tool: 'create_text', ok: true });

    expect(h.bridge.cancel).toHaveBeenCalledWith('active-cancel');
    expect(h.grants.revoke).toHaveBeenCalledWith('active-cancel');
    expect(h.events).toHaveLength(eventCount);
  });
});
