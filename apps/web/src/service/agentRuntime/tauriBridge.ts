import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getApiBaseUrl, getLocalDevApiOrigin, isDesktopShell } from '@/utils/apiBase';
import type { AgentRuntimeProbe } from './types';

export type CodexNativeEvent = {
  runId: string;
  kind: string;
  text?: string;
  phase?: string;
  tool?: string;
  callId?: string;
  ok?: boolean;
  code?: string;
};

export type CodexDesktopStartRequest = {
  runId: string;
  projectId: string;
  prompt: string;
  apiOrigin: string;
  grantToken: string;
};

export interface CodexDesktopBridge {
  discover(): Promise<AgentRuntimeProbe>;
  start(request: CodexDesktopStartRequest): Promise<void>;
  cancel(runId: string): Promise<void>;
  listen(listener: (event: CodexNativeEvent) => void): Promise<UnlistenFn>;
}

export function desktopApiOrigin(): string {
  return (getApiBaseUrl() || getLocalDevApiOrigin()).replace(/\/$/, '');
}

export const codexDesktopBridge: CodexDesktopBridge = {
  async discover() {
    if (!isDesktopShell()) return { available: false, reason: 'not_desktop' };
    return invoke<AgentRuntimeProbe>('discover_codex');
  },
  async start(request) {
    await invoke('start_codex_run', { request });
  },
  async cancel(runId) {
    await invoke('cancel_codex_run', { runId });
  },
  async listen(listener) {
    return listen<CodexNativeEvent>('agent-cli-run-event', (event) => listener(event.payload));
  },
};
