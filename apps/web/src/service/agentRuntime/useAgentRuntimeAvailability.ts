import { useEffect, useState } from 'react';
import { AgentRuntimeBroker } from './AgentRuntimeBroker';
import { CodexCliRuntimeAdapter } from './CodexCliRuntimeAdapter';
import { AGENT_RUNTIME_PREFERENCE_EVENT, loadAgentRuntimePreference } from './preference';
import type { AgentRuntimeProbe } from './types';

/** Settings and the composer use the same broker/adapter/native probe. */
export async function probeCodexRuntime(): Promise<AgentRuntimeProbe> {
  const adapter = new CodexCliRuntimeAdapter();
  const broker = new AgentRuntimeBroker([adapter]);
  try {
    return await broker.probe('cli');
  } finally {
    broker.dispose();
    await adapter.dispose();
  }
}

/** API media generators retain their existing API gate; Agent/Ask honor runtime preference. */
export function useAgentRuntimeAvailability(apiAvailable: boolean | null, agentMode = true) {
  const [preference, setPreference] = useState(loadAgentRuntimePreference);
  const [probe, setProbe] = useState<AgentRuntimeProbe | null>(null);
  const usesApi = !agentMode || preference.mode === 'api';

  useEffect(() => {
    const refreshPreference = () => setPreference(loadAgentRuntimePreference());
    window.addEventListener(AGENT_RUNTIME_PREFERENCE_EVENT, refreshPreference);
    window.addEventListener('storage', refreshPreference);
    return () => {
      window.removeEventListener(AGENT_RUNTIME_PREFERENCE_EVENT, refreshPreference);
      window.removeEventListener('storage', refreshPreference);
    };
  }, []);

  useEffect(() => {
    if (usesApi) return;
    let disposed = false;
    let generation = 0;
    const refresh = async () => {
      const current = ++generation;
      try {
        const next = await probeCodexRuntime();
        if (!disposed && current === generation) setProbe(next);
      } catch {
        if (!disposed && current === generation) setProbe({ available: false, reason: 'unavailable' });
      }
    };
    void refresh();
    window.addEventListener('focus', refresh);
    return () => {
      disposed = true;
      window.removeEventListener('focus', refresh);
    };
  }, [usesApi]);

  return {
    available: usesApi ? apiAvailable : Boolean(probe?.available && probe.authenticated === true),
    usesApi,
  };
}
