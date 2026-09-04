import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntimeBroker } from '../AgentRuntimeBroker';
import { codexDesktopBridge } from '../tauriBridge';
import { saveAgentRuntimePreference } from '../preference';
import { probeCodexRuntime, useAgentRuntimeAvailability } from '../useAgentRuntimeAvailability';

vi.mock('../tauriBridge', () => ({
  codexDesktopBridge: { discover: vi.fn() },
  desktopApiOrigin: () => 'http://127.0.0.1:8000',
}));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(codexDesktopBridge.discover).mockReset();
  vi.mocked(codexDesktopBridge.discover).mockResolvedValue({ available: true, authenticated: true });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('runtime-specific composer availability', () => {
  it('preserves API availability and does not probe CLI by default', () => {
    const { result, rerender } = renderHook(({ api }) => useAgentRuntimeAvailability(api), { initialProps: { api: false } });
    expect(result.current).toEqual({ available: false, usesApi: true });
    rerender({ api: true });
    expect(result.current.available).toBe(true);
    expect(codexDesktopBridge.discover).not.toHaveBeenCalled();
  });

  it('lets an authenticated CLI work when the API has no model key', async () => {
    saveAgentRuntimePreference({ mode: 'cli', cliAgentId: 'codex' });
    const { result } = renderHook(() => useAgentRuntimeAvailability(false));
    expect(result.current.available).toBe(false);
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.usesApi).toBe(false);
  });

  it.each([
    { available: false, reason: 'not_desktop' as const },
    { available: false, reason: 'not_installed' as const },
    { available: true, authenticated: false, reason: 'login_required' as const },
  ])('does not enable an unavailable or unauthenticated CLI: %j', async (probe) => {
    vi.mocked(codexDesktopBridge.discover).mockResolvedValue(probe);
    saveAgentRuntimePreference({ mode: 'cli' });
    const { result } = renderHook(() => useAgentRuntimeAvailability(true));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.available).toBe(false);
  });

  it('keeps media generation on the API gate even with CLI selected', () => {
    saveAgentRuntimePreference({ mode: 'cli' });
    const { result } = renderHook(() => useAgentRuntimeAvailability(false, false));
    expect(result.current).toEqual({ available: false, usesApi: true });
    expect(codexDesktopBridge.discover).not.toHaveBeenCalled();
  });

  it('responds to runtime changes without remounting the editor', async () => {
    const { result } = renderHook(() => useAgentRuntimeAvailability(false));
    act(() => saveAgentRuntimePreference({ mode: 'cli' }));
    await waitFor(() => expect(result.current.available).toBe(true));
    act(() => saveAgentRuntimePreference({ mode: 'api' }));
    expect(result.current.available).toBe(false);
  });

  it('routes the shared settings probe through Broker and the CLI adapter', async () => {
    const probe = vi.spyOn(AgentRuntimeBroker.prototype, 'probe');
    await expect(probeCodexRuntime()).resolves.toEqual({ available: true, authenticated: true });
    expect(probe).toHaveBeenCalledWith('cli');
    expect(codexDesktopBridge.discover).toHaveBeenCalledOnce();
  });
});
