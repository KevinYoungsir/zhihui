import type { AgentRuntimePreference } from './types';

const STORAGE_KEY = 'recombyn.agent.runtime.preference.v1';
export const AGENT_RUNTIME_PREFERENCE_EVENT = 'recombyn:agent-runtime-preference';
const DEFAULT_PREFERENCE: AgentRuntimePreference = { mode: 'api' };

export function loadAgentRuntimePreference(): AgentRuntimePreference {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCE;
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') as {
      mode?: unknown;
    };
    return value.mode === 'cli'
      ? { mode: 'cli', cliAgentId: 'codex' }
      : DEFAULT_PREFERENCE;
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

export function saveAgentRuntimePreference(preference: AgentRuntimePreference): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preference));
  window.dispatchEvent(new CustomEvent(AGENT_RUNTIME_PREFERENCE_EVENT, { detail: preference }));
}
