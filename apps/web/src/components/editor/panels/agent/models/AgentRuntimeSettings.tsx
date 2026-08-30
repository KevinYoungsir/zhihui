import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  codexDesktopBridge,
  loadAgentRuntimePreference,
  saveAgentRuntimePreference,
  type AgentRuntimeMode,
  type AgentRuntimeProbe,
} from '@/service/agentRuntime';
import { cn } from '@/utils/classnames';

type ProbeState = AgentRuntimeProbe & { loading?: boolean };

export default function AgentRuntimeSettings(): ReactNode {
  const { t } = useTranslation();
  const [mode, setMode] = useState<AgentRuntimeMode>(() => loadAgentRuntimePreference().mode);
  const [probe, setProbe] = useState<ProbeState>({ available: false, loading: true });

  const refresh = useCallback(async () => {
    setProbe((current) => ({ ...current, loading: true }));
    try {
      setProbe({ ...(await codexDesktopBridge.discover()), loading: false });
    } catch {
      setProbe({ available: false, reason: 'unavailable', loading: false });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const choose = (next: AgentRuntimeMode) => {
    if (next === 'cli' && (!probe.available || probe.authenticated === false)) return;
    setMode(next);
    saveAgentRuntimePreference(next === 'cli' ? { mode: 'cli', cliAgentId: 'codex' } : { mode: 'api' });
  };

  const codexStatus = probe.loading
    ? t('agent.runtimeChecking')
    : probe.reason === 'not_desktop'
      ? t('agent.runtimeDesktopOnly')
      : !probe.available
        ? t('agent.runtimeNotInstalled')
        : probe.authenticated === false
          ? t('agent.runtimeLoginRequired')
          : t('agent.runtimeReady');

  return (
    <section className="rounded-xl bg-[var(--account-card)] p-6 ring-1 ring-[var(--line)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-semibold text-[var(--ink)]">{t('agent.runtimeTitle')}</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-[var(--muted)]">{t('agent.runtimeHint')}</p>
        </div>
        <button type="button" onClick={() => void refresh()} className="text-[12px] text-[var(--muted)] underline underline-offset-2">
          {t('agent.runtimeRefresh')}
        </button>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <button
          type="button"
          aria-pressed={mode === 'api'}
          onClick={() => choose('api')}
          className={cn('rounded-lg p-4 text-left ring-1 transition', mode === 'api' ? 'bg-[var(--accent-soft)] ring-[var(--ink)]/25' : 'bg-[var(--account-main)] ring-[var(--line)]')}
        >
          <span className="block text-[14px] font-medium text-[var(--ink)]">{t('agent.runtimeApi')}</span>
          <span className="mt-1 block text-[12px] leading-relaxed text-[var(--muted)]">{t('agent.runtimeApiHint')}</span>
        </button>
        <button
          type="button"
          aria-pressed={mode === 'cli'}
          disabled={probe.loading || !probe.available || probe.authenticated === false}
          onClick={() => choose('cli')}
          className={cn('rounded-lg p-4 text-left ring-1 transition disabled:cursor-not-allowed disabled:opacity-55', mode === 'cli' ? 'bg-[var(--accent-soft)] ring-[var(--ink)]/25' : 'bg-[var(--account-main)] ring-[var(--line)]')}
        >
          <span className="block text-[14px] font-medium text-[var(--ink)]">{t('agent.runtimeCodex')}</span>
          <span className="mt-1 block text-[12px] text-[var(--muted)]">{codexStatus}{probe.version ? ` · ${probe.version}` : ''}</span>
        </button>
      </div>
      <p className="mt-4 rounded-lg bg-[var(--account-main)] px-3 py-2.5 text-[12px] leading-relaxed text-[var(--muted)] ring-1 ring-[var(--line)]">
        {t('agent.runtimeSecurity')}
      </p>
    </section>
  );
}
