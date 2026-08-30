import { describe, expect, it, vi } from 'vitest';
import { CodexCliRuntimeAdapter } from '../CodexCliRuntimeAdapter';
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
  it('mints a scoped grant and revokes it on completion', async () => {
    const { bridge, grants, emit } = harness();
    const adapter = new CodexCliRuntimeAdapter(bridge, grants);
    const running = adapter.startRun({ runId: 'run-1', projectId: 'project-1', prompt: 'create title' });
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
    const running = adapter.startRun({ runId: 'run-2', projectId: 'project-1', prompt: 'create title' });
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
    await adapter.startRun({ runId: 'run-3', projectId: 'project-1', prompt: 'create title' });
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
    await adapter.startRun({ runId: 'run-4', projectId: 'project-1', prompt: 'create title' });
    expect(errors).toContain('codex_login_required');
    expect(grants.create).not.toHaveBeenCalled();
  });

  it('revokes the grant when the Codex process reports a crash', async () => {
    const { bridge, grants, emit } = harness();
    const adapter = new CodexCliRuntimeAdapter(bridge, grants);
    const running = adapter.startRun({ runId: 'run-5', projectId: 'project-1', prompt: 'create title' });
    await vi.waitFor(() => expect(bridge.start).toHaveBeenCalled());
    emit({ runId: 'run-5', kind: 'run.error', code: 'codex_process_failed' });
    await running;
    expect(grants.revoke).toHaveBeenCalledWith('run-5');
  });
});
