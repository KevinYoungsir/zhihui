/**
 * Account Agent tab: Auto routing prefs + custom OpenAI-style providers (Pro).
 */

import { useEffect, useRef, useState, type ReactNode, memo } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { HiOutlinePlus, HiOutlineTrash } from 'react-icons/hi2';
import {
  invalidateChatModelsCache,
  type ChatModelsResponse,
  type ByokPlatform,
} from '@/service/chat';
import { type DesignCatalog } from '@/service/design';
import { apiQuery } from '@/service/client';
import { Select } from '@/components/base';
import AccountSettingsDialog from '@/components/layout/AccountSettingsDialog';
import { cn } from '@/utils/classnames';
import { getToken } from '@/utils/token';
import { readFileAsDataUrl } from '@/utils/uploadImage';
import { useWalletSnapshot } from '@/service/wallet';
import { planAllowsCustomModels } from '@/utils/wallet';
import { isLocalCanvasMode } from '@/utils/localCanvasMode';
import {
  createCustomLlmProviderId,
  createPlatformModelId,
  customProvidersAsModels,
  discoverUpstreamModels,
  hydrateCustomLlmProviders,
  isPlatformByokId,
  isPlatformModelId,
  persistCustomLlmProvider,
  platformProviderFromModelId,
  removeCustomLlmProvider,
  type CustomLlmProvider,
  type CustomModelKind,
  type DiscoveredProviderModel,
  type ProviderDiscoveryResponse,
  type ProviderProtocol,
} from '../customLlmProviders';
import { CUSTOM_MODEL_ICON_OPTIONS, ModelBrandIcon } from './ModelPickerPanel';
import {
  cachePresetRules,
  getCachedOpenrouterAvailability,
  warmOpenrouterAvailability,
} from '../agentRoutePrefs';
import {
  AgentRoutePrefsEditor,
  routeCatalogFromListModels,
  splitByokRouteModels,
  type SharedRouteCatalog,
} from './AgentRoutePrefsEditor';
import AgentRuntimeSettings from './AgentRuntimeSettings';

type Props = {
  onProvidersChange?: () => void;
  /** When set (e.g. inside settings modal), open plans tab instead of nested dialog. */
  onRequestUpgrade?: () => void;
};

const fieldClass =
  'mt-1.5 w-full rounded-lg border-0 bg-[var(--account-main)] px-3 py-2 text-[14px] text-[var(--ink)] outline-none ring-1 ring-[var(--line)] transition placeholder:text-[var(--muted)] focus:ring-[var(--ink)]/25';

const selectFieldClass =
  'mt-1.5 w-full !h-10 rounded-lg border-0 bg-[var(--account-main)] px-3 pr-8 text-[14px] text-[var(--ink)] ring-1 ring-[var(--line)]';

function parseCustomModelKind(value: string): CustomModelKind {
  if (value === 'vision') return 'vision';
  if (value === 'image') return 'image';
  if (value === 'video') return 'video';
  return 'text';
}


const MANUAL_PROVIDER_ID = '__manual__';


function platformModelKindOptions(t: (key: string) => string) {
  return [
    { value: 'text', label: t('agent.providerModelKindText') },
    { value: 'image', label: t('agent.providerModelKindImage') },
    { value: 'video', label: t('agent.providerModelKindVideo') },
    { value: 'vision', label: t('agent.providerModelKindVision') },
  ];
}


function ModelIconPickerFields(props: {
  iconKey: string;
  iconUrl: string;
  required?: boolean;
  t: (key: string, opts?: Record<string, unknown>) => string;
  onIconKey: (v: string) => void;
  onIconUrl: (v: string) => void;
}): ReactNode {
  const { iconKey, iconUrl, required, t, onIconKey, onIconUrl } = props;
  const fileRef = useRef<HTMLInputElement | null>(null);

  const pickPreset = (key: string) => {
    if (iconKey === key && !iconUrl) onIconKey('');
    else {
      onIconUrl('');
      onIconKey(key);
    }
  };

  const onUploadIcon = (file: File | null) => {
    if (!file || !file.type.startsWith('image/')) return;
    async function applyUploadedIcon() {
      try {
        const dataUrl = await readFileAsDataUrl(file);
        onIconKey('');
        onIconUrl(dataUrl);
      } catch {
        /* ignore read errors */
      }
    }
    applyUploadedIcon();
  };

  return (
    <div className="mb-4">
      <span className="text-[13px] font-medium text-[var(--ink)]">
        {t('agent.providerModelIcon')}
        {required ? <span className="text-red-500"> *</span> : null}
        {!required ? (
          <span className="ml-1 font-normal text-[var(--muted)]">
            ({t('agent.providerOptional')})
          </span>
        ) : null}
      </span>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <button
          type="button"
          title={t('agent.providerModelIconUpload')}
          aria-label={t('agent.providerModelIconUpload')}
          className={cn(
            'inline-flex h-9 w-9 items-center justify-center rounded-lg ring-1 transition',
            iconUrl
              ? 'ring-[var(--ink)]'
              : 'ring-[var(--line)] hover:bg-[var(--accent-soft)]'
          )}
          onClick={() => fileRef.current?.click()}
        >
          {iconUrl ? (
            <img src={iconUrl} alt="" className="h-5 w-5 rounded object-cover" />
          ) : (
            <HiOutlinePlus className="h-4 w-4 text-[var(--ink)]" />
          )}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            onUploadIcon(e.target.files?.[0] || null);
            e.target.value = '';
          }}
        />
        {CUSTOM_MODEL_ICON_OPTIONS.map((opt) => {
          const selected = !iconUrl && iconKey === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              title={opt.label}
              aria-label={opt.label}
              aria-pressed={selected}
              className={cn(
                'inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--account-card)] ring-1 transition',
                selected
                  ? 'ring-[var(--ink)]'
                  : 'ring-[var(--line)] hover:bg-[var(--accent-soft)]'
              )}
              onClick={() => pickPreset(opt.key)}
            >
              <ModelBrandIcon model={{ iconKey: opt.key, label: opt.label }} size={18} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AddPlatformModelFields(props: {
  fieldClass: string;
  selectFieldClass: string;
  apiId: string;
  name: string;
  kind: CustomModelKind;
  iconKey: string;
  iconUrl: string;
  t: (key: string, opts?: Record<string, unknown>) => string;
  onApiId: (v: string) => void;
  onName: (v: string) => void;
  onKind: (v: CustomModelKind) => void;
  onIconKey: (v: string) => void;
  onIconUrl: (v: string) => void;
}): ReactNode {
  const {
    fieldClass,
    selectFieldClass,
    apiId,
    name,
    kind,
    iconKey,
    iconUrl,
    t,
    onApiId,
    onName,
    onKind,
    onIconKey,
    onIconUrl,
  } = props;
  const req = <span className="text-red-500"> *</span>;

  return (
    <>
      <p className="mb-3 text-[12px] leading-relaxed text-[var(--muted)]">
        {t('agent.providerAddPlatformModelHint')}
      </p>
      <label className="mb-4 block">
        <span className="text-[13px] font-medium text-[var(--ink)]">
          {t('agent.providerApiModel')}
          {req}
        </span>
        <input
          className={fieldClass}
          value={apiId}
          onChange={(e) => onApiId(e.target.value)}
          placeholder={t('agent.providerApiModelPh')}
          autoComplete="off"
        />
      </label>
      <label className="mb-4 block">
        <span className="text-[13px] font-medium text-[var(--ink)]">
          {t('agent.providerPlatformModelName')}
          {req}
        </span>
        <input
          className={fieldClass}
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder={t('agent.providerPlatformModelNamePh')}
          autoComplete="off"
        />
      </label>
      <ModelIconPickerFields
        iconKey={iconKey}
        iconUrl={iconUrl}
        required
        t={t}
        onIconKey={onIconKey}
        onIconUrl={onIconUrl}
      />
      <label className="mb-4 block">
        <span className="text-[13px] font-medium text-[var(--ink)]">
          {t('agent.providerModelKind')}
          {req}
        </span>
        <Select
          size="large"
          className={selectFieldClass}
          value={kind === 'platform' ? 'text' : kind}
          options={platformModelKindOptions(t)}
          onChange={(v) => onKind(parseCustomModelKind(String(v)))}
        />
      </label>
    </>
  );
}


function customModelKindLabelKey(kind: CustomModelKind): string {
  if (kind === 'vision') return 'agent.providerModelKindVision';
  if (kind === 'image') return 'agent.providerModelKindImage';
  if (kind === 'video') return 'agent.providerModelKindVideo';
  if (kind === 'platform') return 'agent.providerModelKindPlatform';
  return 'agent.providerModelKindText';
}

function AgentModelsPanel({
  onProvidersChange,
  onRequestUpgrade,
}: Props): ReactNode {
  const { t } = useTranslation();
  const { planId } = useWalletSnapshot();
  const canCustom = isLocalCanvasMode() || planAllowsCustomModels(planId);
  const [providers, setProviders] = useState<CustomLlmProvider[]>([]);
  const [platforms, setPlatforms] = useState<ByokPlatform[]>([]);
  /** Shared with RoutePrefsEditor — one GET /chat/models for the whole Agent tab. */
  const [sharedCatalog, setSharedCatalog] = useState<SharedRouteCatalog | null>(null);
  // '' = nothing picked yet; MANUAL_PROVIDER_ID = free-text; else a platform id.
  const [presetId, setPresetId] = useState('');
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiModel, setApiModel] = useState('');
  const [modelKind, setModelKind] = useState<CustomModelKind>('text');
  const [providerProtocol, setProviderProtocol] = useState<ProviderProtocol>('auto');
  const [discovery, setDiscovery] = useState<ProviderDiscoveryResponse | null>(null);
  const [discoveryKind, setDiscoveryKind] = useState<'image' | 'video' | 'text'>('image');
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Optional extra model id while adding a platform key (also reused for銆屾坊鍔犳ā鍨嬨€峯n saved rows).
  const [addModelForId, setAddModelForId] = useState('');
  const [addModelName, setAddModelName] = useState('');
  const [addModelApiId, setAddModelApiId] = useState('');
  const [addModelKind, setAddModelKind] = useState<CustomModelKind>('text');
  const [addModelIconKey, setAddModelIconKey] = useState('');
  const [addModelIconUrl, setAddModelIconUrl] = useState('');
  const [addModelError, setAddModelError] = useState('');
  const [providerIconKey, setProviderIconKey] = useState('');
  const [providerIconUrl, setProviderIconUrl] = useState('');

  const selectedPlatform =
    presetId && presetId !== MANUAL_PROVIDER_ID
      ? platforms.find((p) => p.id === presetId) ?? null
      : null;
  const isManualProvider = presetId === MANUAL_PROVIDER_ID;

  const askUpgrade = () => {
    if (onRequestUpgrade) onRequestUpgrade();
    else setSettingsOpen(true);
  };

  const modelsQuery = useQuery({
    ...apiQuery.chatGetModels.queryOptions(),
    staleTime: 60_000,
  });
  const designCatalogQuery = useQuery({
    ...apiQuery.designDesignCatalog.queryOptions(),
    staleTime: 60_000,
  });
  const byokAuthed = Boolean(getToken());
  const byokListQuery = useQuery({
    ...apiQuery.meMeByokList.queryOptions(),
    staleTime: 30_000,
    enabled: byokAuthed,
  });

  const persistProviderMutation = useMutation({
    mutationFn: (provider: CustomLlmProvider) => persistCustomLlmProvider(provider),
  });
  const removeProviderMutation = useMutation({
    mutationFn: (id: string) => removeCustomLlmProvider(id),
  });
  const discoverModelsMutation = useMutation({
    mutationFn: discoverUpstreamModels,
  });

  useEffect(() => {
    if (byokAuthed && !byokListQuery.isFetched) return;
    let cancelled = false;
    async function hydrateProviders() {
      // Hits warm Query cache from byokListQuery when logged in.
      let list: CustomLlmProvider[] = [];
      try {
        list = await hydrateCustomLlmProviders();
      } catch {
        list = [];
      }
      if (cancelled) return;
      setProviders(list);
    }
    hydrateProviders();
    return () => {
      cancelled = true;
    };
  }, [byokAuthed, byokListQuery.isFetched, byokListQuery.dataUpdatedAt]);

  useEffect(() => {
    if (!modelsQuery.isFetched) return;
    const res = modelsQuery.data as ChatModelsResponse | undefined;
    if (res) {
      const plat = res.byokPlatforms ?? [];
      setPlatforms(
        plat.map((p) => ({
          ...p,
          rowId: p.rowId || `platform:${p.id}`,
          kinds: p.kinds?.length ? p.kinds : ['text'],
        }))
      );
      const orOk = res.openrouterAvailable !== false;
      warmOpenrouterAvailability(orOk);
      const { text, image } = routeCatalogFromListModels(res);
      setSharedCatalog({ text, image, openrouterAvailable: orOk });
      return;
    }
    setSharedCatalog({ text: [], image: [], openrouterAvailable: null });
  }, [modelsQuery.data, modelsQuery.isFetched, providers]);

  useEffect(() => {
    const cat = designCatalogQuery.data as DesignCatalog | undefined;
    if (!cat) return;
    cachePresetRules(cat.global_rules || {});
  }, [designCatalogQuery.data]);

  const persistProviders = (next: CustomLlmProvider[]) => {
    setProviders(next);
    onProvidersChange?.();
    invalidateChatModelsCache();
  };

  const onPickPlatform = (id: string) => {
    setPresetId(id);
    setError('');
    setAddModelApiId('');
    setAddModelName('');
    setAddModelKind('text');
    setAddModelIconKey('');
    setAddModelIconUrl('');
    setAddModelError('');
    setDiscovery(null);
    if (id === MANUAL_PROVIDER_ID || !id) {
      setModelKind('text');
      setApiModel('');
      setProviderIconKey('');
      setProviderIconUrl('');
      return;
    }
    const platform = platforms.find((p) => p.id === id);
    if (!platform) return;
    setBaseUrl(platform.baseUrl);
    setWebsite(platform.website || '');
    setName(platform.name);
    setApiModel('*');
    setModelKind('platform');
  };

  const resetForm = () => {
    setPresetId('');
    setName('');
    setWebsite('');
    setApiKey('');
    setBaseUrl('');
    setApiModel('');
    setModelKind('text');
    setProviderProtocol('auto');
    setDiscovery(null);
    setDiscoveryKind('image');
    setAddModelApiId('');
    setAddModelName('');
    setAddModelKind('text');
    setAddModelIconKey('');
    setAddModelIconUrl('');
    setAddModelError('');
    setProviderIconKey('');
    setProviderIconUrl('');
  };

  const providerSelectOptions = [
    ...platforms.map((p) => ({
      value: p.id,
      label: p.name,
    })),
    { value: MANUAL_PROVIDER_ID, label: t('agent.providerPresetManual') },
  ];

  const onDiscoverModels = async () => {
    const url = baseUrl.trim().replace(/\/+$/, '');
    const key = apiKey.trim();
    if (!url || !/^https?:\/\//i.test(url)) {
      setError(t('agent.providerBaseUrlInvalid'));
      return;
    }
    if (!key) {
      setError(t('agent.providerApiKeyRequired', { defaultValue: 'API key is required' }));
      return;
    }
    setError('');
    setDiscovery(null);
    try {
      const result = await discoverModelsMutation.mutateAsync({
        baseUrl: url,
        apiKey: key,
        protocol: providerProtocol,
      });
      setDiscovery(result);
      const nextKind = result.categories.image.length
        ? 'image'
        : result.categories.video.length
          ? 'video'
          : 'text';
      setDiscoveryKind(nextKind);
      if (!result.total) {
        setError(
          t('agent.providerDiscoverEmpty', {
            defaultValue: '上游接口已连接，但没有返回可用模型。',
          })
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('agent.providerDiscoverFailed', { defaultValue: '读取上游模型失败' })
      );
    }
  };

  const onPickDiscoveredModel = (model: DiscoveredProviderModel) => {
    setApiModel(model.id);
    setModelKind(model.kind === 'image' || model.kind === 'video' ? model.kind : 'text');
    if (!name.trim()) setName(model.label || model.id);
  };

  const onSaveProvider = () => {
    if (!canCustom) {
      askUpgrade();
      return;
    }
    const isPlatform = Boolean(selectedPlatform) || modelKind === 'platform';
    // Platform presets always carry name / baseUrl — refill if the user cleared an autofilled field.
    const n = (name.trim() || selectedPlatform?.name || '').trim();
    const url = (baseUrl.trim() || selectedPlatform?.baseUrl || '').trim().replace(/\/+$/, '');
    const site = (website.trim() || selectedPlatform?.website || '').trim();
    if (!isPlatform && !modelKind) {
      setError(t('agent.providerModelKindRequired'));
      return;
    }
    if (!n) {
      setError(t('agent.providerNameRequired'));
      return;
    }
    if (!url) {
      setError(t('agent.providerBaseUrlRequired'));
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      setError(t('agent.providerBaseUrlInvalid'));
      return;
    }
    // Aggregators: one key unlocks the catalog (`*` sentinel). Custom may omit model ID
    // and fall back to the provider name (same as hydrate).
    const mid = isPlatform ? '*' : (apiModel.trim() || n);
    const key = apiKey.trim();
    if (!key) {
      setError(t('agent.providerApiKeyRequired', { defaultValue: 'API key is required' }));
      return;
    }
    setError('');
    const draft: CustomLlmProvider = {
      id: selectedPlatform
        ? selectedPlatform.rowId || `platform:${selectedPlatform.id}`
        : createCustomLlmProviderId(),
      name: n,
      website: site,
      apiKey: key,
      baseUrl: url,
      apiModel: mid,
      modelKind: isPlatform ? 'platform' : modelKind,
      iconKey: isPlatform ? '' : providerIconKey.trim(),
      iconUrl: isPlatform ? '' : providerIconUrl.trim(),
      createdAt: Date.now(),
    };
    const extraMid = isPlatform ? addModelApiId.trim() : '';
    const extraName = addModelName.trim();
    const extraIconKey = addModelIconKey.trim();
    const extraIconUrl = addModelIconUrl.trim();
    const extraKind = addModelKind === 'platform' ? 'text' : addModelKind;
    const extraStarted = Boolean(extraMid || extraName || extraIconKey || extraIconUrl);
    if (extraStarted) {
      if (!extraMid) {
        setError(t('agent.providerApiModelRequired', { defaultValue: '请填写模型 ID' }));
        return;
      }
      if (!extraName) {
        setError(t('agent.providerPlatformModelNameRequired'));
        return;
      }
      if (!extraIconKey && !extraIconUrl) {
        setError(t('agent.providerModelIconRequired'));
        return;
      }
      if (!extraKind) {
        setError(t('agent.providerModelKindRequired'));
        return;
      }
    }
    async function saveProvider() {
      try {
        const saved = await persistProviderMutation.mutateAsync(draft);
        let next = [saved, ...providers.filter((p) => p.id !== saved.id)];
        if (extraMid && selectedPlatform) {
          const child: CustomLlmProvider = {
            id: createPlatformModelId(selectedPlatform.id),
            name: extraName,
            website: site,
            apiKey: '',
            baseUrl: url,
            apiModel: extraMid,
            modelKind: extraKind,
            iconKey: extraIconKey,
            iconUrl: extraIconUrl,
            createdAt: Date.now(),
          };
          try {
            const savedChild = await persistProviderMutation.mutateAsync(child);
            next = [savedChild, ...next.filter((p) => p.id !== savedChild.id)];
          } catch {
            setError(t('agent.providerPlatformModelFailed'));
            persistProviders(next);
            return;
          }
        }
        persistProviders(next);
        resetForm();
      } catch {
        setError(t('agent.providerSaveFailed', { defaultValue: 'Failed to save provider' }));
      }
    }
    saveProvider();
  };

  const onRemove = (id: string) => {
    if (!canCustom) {
      askUpgrade();
      return;
    }
    const removeIds = new Set<string>([id]);
    if (isPlatformByokId(id) || providers.find((p) => p.id === id)?.modelKind === 'platform') {
      for (const child of childModelsOf(id)) removeIds.add(child.id);
    }
    async function removeProviders() {
      await Promise.all(
        [...removeIds].map((rid) => removeProviderMutation.mutateAsync(rid))
      );
      persistProviders(providers.filter((p) => !removeIds.has(p.id)));
      if (addModelForId === id) closeAddModel();
    }
    removeProviders();
  };

  const openAddModel = (platformRowId: string) => {
    setAddModelForId(platformRowId);
    setAddModelName('');
    setAddModelApiId('');
    setAddModelKind('text');
    setAddModelIconKey('');
    setAddModelIconUrl('');
    setAddModelError('');
  };

  const closeAddModel = () => {
    setAddModelForId('');
    setAddModelName('');
    setAddModelApiId('');
    setAddModelKind('text');
    setAddModelIconKey('');
    setAddModelIconUrl('');
    setAddModelError('');
  };

  const onSavePlatformModel = (platformRow: CustomLlmProvider) => {
    if (!canCustom) {
      askUpgrade();
      return;
    }
    const mid = addModelApiId.trim();
    const n = addModelName.trim();
    const iconKey = addModelIconKey.trim();
    const iconUrl = addModelIconUrl.trim();
    const kind = addModelKind === 'platform' ? 'text' : addModelKind;
    if (!mid) {
      setAddModelError(t('agent.providerApiModelRequired', { defaultValue: '请填写模型 ID' }));
      return;
    }
    if (!n) {
      setAddModelError(t('agent.providerPlatformModelNameRequired'));
      return;
    }
    if (!iconKey && !iconUrl) {
      setAddModelError(t('agent.providerModelIconRequired'));
      return;
    }
    if (!kind) {
      setAddModelError(t('agent.providerModelKindRequired'));
      return;
    }
    const providerKey =
      platformProviderFromModelId(platformRow.id) ||
      (isPlatformByokId(platformRow.id)
        ? platformRow.id.slice('platform:'.length)
        : platforms.find((x) => x.rowId === platformRow.id)?.id || '');
    if (!providerKey) {
      setAddModelError(t('agent.providerPlatformModelFailed'));
      return;
    }
    setAddModelError('');
    const draft: CustomLlmProvider = {
      id: createPlatformModelId(providerKey),
      name: n,
      website: platformRow.website || '',
      apiKey: '',
      baseUrl: platformRow.baseUrl,
      apiModel: mid,
      modelKind: kind,
      iconKey,
      iconUrl,
      createdAt: Date.now(),
    };
    async function savePlatformModel() {
      try {
        const saved = await persistProviderMutation.mutateAsync(draft);
        persistProviders([saved, ...providers.filter((p) => p.id !== saved.id)]);
        closeAddModel();
      } catch {
        setAddModelError(t('agent.providerPlatformModelFailed'));
      }
    }
    savePlatformModel();
  };

  const platformRows = providers.filter(
    (p) => isPlatformByokId(p.id) || p.modelKind === 'platform'
  );
  const childModelsOf = (platformRowId: string) => {
    const key = isPlatformByokId(platformRowId)
      ? platformRowId.slice('platform:'.length)
      : platforms.find((x) => x.rowId === platformRowId)?.id || '';
    return providers.filter(
      (p) => isPlatformModelId(p.id) && platformProviderFromModelId(p.id) === key
    );
  };
  const otherProviders = providers.filter(
    (p) =>
      !isPlatformByokId(p.id) &&
      p.modelKind !== 'platform' &&
      !isPlatformModelId(p.id)
  );

  return (
    <>
      <div className="space-y-5">
        <AgentRuntimeSettings />
        <section className="rounded-xl bg-[var(--account-card)] p-6 ring-1 ring-[var(--line)]">
          <AgentRoutePrefsEditor sharedCatalog={sharedCatalog} />
        </section>

        <section className="rounded-xl bg-[var(--account-card)] p-6 ring-1 ring-[var(--line)]">
          <h2 className="mb-1 text-[15px] font-semibold text-[var(--ink)]">
            {t('account.agentModelsSection')}
          </h2>
          <p className="mb-5 text-[13px] leading-relaxed text-[var(--muted)]">
            {t('agent.settingsHint')}
          </p>

          {!canCustom ? (
            <div className="mb-5 rounded-lg bg-[var(--account-main)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--ink)] ring-1 ring-[var(--line)]">
              <p className="font-medium">{t('agent.providerMemberRequired')}</p>
              <p className="mt-1 text-[var(--muted)]">{t('agent.providerMemberHint')}</p>
              <button
                type="button"
                className="mt-2 text-[13px] font-medium text-[var(--ink)] underline underline-offset-2"
                onClick={askUpgrade}
              >
                {t('agent.providerUpgrade')}
              </button>
            </div>
          ) : null}

          <fieldset disabled={!canCustom} className={cn(!canCustom && 'opacity-50')}>
            <label className="mb-4 block">
              <span className="text-[13px] font-medium text-[var(--ink)]">
                {t('agent.providerPresetLabel')}
                <span className="text-red-500"> *</span>
              </span>
              <Select
                size="large"
                className={selectFieldClass}
                value={presetId}
                placeholder={t('agent.providerPresetPlaceholder')}
                options={providerSelectOptions}
                onChange={(v) => onPickPlatform(String(v))}
              />
              <span className="mt-1.5 block text-[12px] text-[var(--muted)]">
                {isManualProvider
                  ? t('agent.providerManualHint', {
                      defaultValue:
                        'Custom endpoint: fill API key, base URL, and the upstream model id (e.g. deepseek-chat).',
                    })
                  : selectedPlatform
                    ? t('agent.providerPlatformHint')
                    : t('agent.providerPresetHint')}
              </span>
            </label>

            {presetId ? (
              <>
                <label className="mb-4 block">
                  <span className="text-[13px] font-medium text-[var(--ink)]">
                    API Key
                    <span className="text-red-500"> *</span>
                  </span>
                  <input
                    className={fieldClass}
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={t('agent.providerApiKeyPh')}
                    autoComplete="off"
                  />
                  <span className="mt-1.5 block text-[12px] text-[var(--muted)]">
                    {t('agent.providerApiKeyHint')}
                  </span>
                </label>

                {selectedPlatform ? (
                  <AddPlatformModelFields
                    fieldClass={fieldClass}
                    selectFieldClass={selectFieldClass}
                    t={t}
                    apiId={addModelApiId}
                    name={addModelName}
                    iconKey={addModelIconKey}
                    iconUrl={addModelIconUrl}
                    kind={addModelKind}
                    onApiId={setAddModelApiId}
                    onName={setAddModelName}
                    onIconKey={setAddModelIconKey}
                    onIconUrl={setAddModelIconUrl}
                    onKind={setAddModelKind}
                  />
                ) : null}

                {isManualProvider ? (
                  <>
                    <label className="mb-4 block">
                      <span className="text-[13px] font-medium text-[var(--ink)]">
                        {t('agent.providerAccessMode', { defaultValue: '接入模式' })}
                      </span>
                      <div className="mt-1.5 rounded-lg bg-[var(--account-main)] p-1 ring-1 ring-[var(--line)]">
                        <button
                          type="button"
                          className="h-8 w-full rounded-md bg-[var(--account-card)] text-[13px] font-medium text-[var(--ink)] shadow-sm"
                        >
                          {t('agent.providerApiMode', { defaultValue: '上游 API 模式' })}
                        </button>
                      </div>
                    </label>

                    <label className="mb-4 block">
                      <span className="text-[13px] font-medium text-[var(--ink)]">
                        {t('agent.providerProtocol', { defaultValue: 'API 协议' })}
                      </span>
                      <Select
                        size="large"
                        className={selectFieldClass}
                        value={providerProtocol}
                        options={[
                          { value: 'auto', label: t('agent.providerProtocolAuto', { defaultValue: '自动识别' }) },
                          { value: 'openai', label: 'OpenAI Compatible' },
                          { value: 'gemini', label: 'Google Gemini' },
                          { value: 'volcengine', label: 'Volcengine Ark' },
                          { value: 'runninghub', label: 'RunningHub' },
                        ]}
                        onChange={(v) => {
                          setProviderProtocol(String(v) as ProviderProtocol);
                          setDiscovery(null);
                        }}
                      />
                    </label>

                    <label className="mb-4 block">
                      <span className="text-[13px] font-medium text-[var(--ink)]">
                        {t('agent.providerModelKind')}
                        <span className="text-red-500"> *</span>
                      </span>
                      <Select
                        size="large"
                        className={selectFieldClass}
                        value={modelKind === 'platform' ? 'text' : modelKind}
                        options={[
                          { value: 'text', label: t('agent.providerModelKindText') },
                          { value: 'vision', label: t('agent.providerModelKindVision') },
                          { value: 'image', label: t('agent.providerModelKindImage') },
                          { value: 'video', label: t('agent.providerModelKindVideo') },
                        ]}
                        onChange={(v) => setModelKind(parseCustomModelKind(String(v)))}
                      />
                      <span className="mt-1.5 block text-[12px] text-[var(--muted)]">
                        {t('agent.providerModelKindHint')}
                      </span>
                    </label>

                    <label className="mb-4 block">
                      <span className="text-[13px] font-medium text-[var(--ink)]">
                        {t('agent.providerApiModel', { defaultValue: '模型 ID' })}
                        <span className="ml-1 text-[11px] font-normal text-[var(--muted)]">
                          ({t('agent.providerOptional')})
                        </span>
                      </span>
                      <input
                        className={fieldClass}
                        value={apiModel}
                        onChange={(e) => setApiModel(e.target.value)}
                        placeholder={t('agent.providerApiModelPh', {
                          defaultValue: '例如 gpt-4o / deepseek-chat',
                        })}
                        autoComplete="off"
                      />
                      <span className="mt-1.5 block text-[12px] text-[var(--muted)]">
                        {t('agent.providerApiModelHint', {
                          defaultValue: '上游 chat/completions 使用的 model 字段，不是供应商显示名。',
                        })}
                      </span>
                    </label>

                    <ModelIconPickerFields
                      iconKey={providerIconKey}
                      iconUrl={providerIconUrl}
                      t={t}
                      onIconKey={setProviderIconKey}
                      onIconUrl={setProviderIconUrl}
                    />
                  </>
                ) : null}

                <label className="mb-4 block">
                  <span className="text-[13px] font-medium text-[var(--ink)]">
                    {t('agent.providerName')}
                    {isManualProvider ? <span className="text-red-500"> *</span> : null}
                  </span>
                  <input
                    className={fieldClass}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('agent.providerNamePh')}
                    autoComplete="off"
                    required={isManualProvider}
                  />
                </label>

                {isManualProvider ? (
                  <div className="mb-4 rounded-xl bg-[var(--account-main)] p-3 ring-1 ring-[var(--line)]">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-[13px] font-medium text-[var(--ink)]">
                          {t('agent.providerDiscoverTitle', { defaultValue: '读取上游模型' })}
                        </p>
                        <p className="mt-0.5 text-[11px] text-[var(--muted)]">
                          {t('agent.providerDiscoverHint', {
                            defaultValue: '连接 /models，并自动分类为图片、视频和对话模型。',
                          })}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={discoverModelsMutation.isPending}
                        className="shrink-0 rounded-lg bg-[var(--ink)] px-3 py-2 text-[12px] font-medium text-[var(--on-brand)] disabled:opacity-50"
                        onClick={() => void onDiscoverModels()}
                      >
                        {discoverModelsMutation.isPending
                          ? t('agent.providerDiscovering', { defaultValue: '读取中…' })
                          : t('agent.providerDiscover', { defaultValue: '读取模型' })}
                      </button>
                    </div>

                    {discovery?.total ? (
                      <div className="mt-3">
                        <div className="grid grid-cols-3 gap-1 rounded-lg bg-[var(--account-card)] p-1">
                          {(['image', 'video', 'text'] as const).map((kind) => {
                            const label =
                              kind === 'image'
                                ? t('agent.providerModelKindImage')
                                : kind === 'video'
                                  ? t('agent.providerModelKindVideo')
                                  : t('agent.providerModelKindText');
                            const count = discovery.categories[kind].length;
                            return (
                              <button
                                key={kind}
                                type="button"
                                className={cn(
                                  'h-8 rounded-md text-[12px] transition',
                                  discoveryKind === kind
                                    ? 'bg-[var(--ink)] text-[var(--on-brand)]'
                                    : 'text-[var(--muted)] hover:text-[var(--ink)]'
                                )}
                                onClick={() => setDiscoveryKind(kind)}
                              >
                                {label} ({count})
                              </button>
                            );
                          })}
                        </div>
                        <div className="mt-2 max-h-48 space-y-1 overflow-y-auto pr-1">
                          {discovery.categories[discoveryKind].map((model) => {
                            const selected = apiModel === model.id;
                            return (
                              <button
                                key={model.id}
                                type="button"
                                className={cn(
                                  'flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-[12px] ring-1 transition',
                                  selected
                                    ? 'bg-[var(--accent-soft)] text-[var(--ink)] ring-[var(--ink)]/20'
                                    : 'bg-[var(--account-card)] text-[var(--muted)] ring-[var(--line)] hover:text-[var(--ink)]'
                                )}
                                onClick={() => onPickDiscoveredModel(model)}
                              >
                                <span className="min-w-0">
                                  <span className="block truncate font-medium">{model.label}</span>
                                  <span className="block truncate text-[10px] opacity-70">{model.id}</span>
                                </span>
                                <span className="shrink-0">{selected ? '✓' : ''}</span>
                              </button>
                            );
                          })}
                          {!discovery.categories[discoveryKind].length ? (
                            <p className="px-2 py-3 text-center text-[11px] text-[var(--muted)]">
                              {t('agent.providerDiscoverCategoryEmpty', {
                                defaultValue: '该分类没有检测到模型',
                              })}
                            </p>
                          ) : null}
                        </div>
                        <p className="mt-2 text-[10px] text-[var(--muted)]">
                          {t('agent.providerDiscoverSummary', {
                            defaultValue: '已读取 {{count}} 个模型 · {{protocol}}',
                            count: discovery.total,
                            protocol: discovery.protocol,
                          })}
                        </p>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <label className="mb-4 block">
                  <span className="text-[13px] font-medium text-[var(--ink)]">
                    {t('agent.providerBaseUrl')}
                    {isManualProvider ? <span className="text-red-500"> *</span> : null}
                  </span>
                  <input
                    className={fieldClass}
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://api.example.com"
                    autoComplete="off"
                    required={isManualProvider}
                  />
                  {isManualProvider ? (
                    <span className="mt-1.5 block rounded-lg bg-[#FFF8E6] px-2.5 py-2 text-[12px] leading-relaxed text-[#8A6D1D] dark:bg-[#3A3218] dark:text-[#E8D48A]">
                      {t('agent.providerBaseUrlHint')}
                    </span>
                  ) : (
                    <span className="mt-1.5 block text-[12px] text-[var(--muted)]">
                      {t('agent.providerPlatformAutofillHint')}
                    </span>
                  )}
                </label>

                <label className="mb-4 block">
                  <span className="text-[13px] font-medium text-[var(--ink)]">
                    {t('agent.providerWebsite')}
                  </span>
                  <input
                    className={fieldClass}
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="https://"
                    autoComplete="off"
                  />
                </label>
              </>
            ) : null}
          </fieldset>

          {error ? <p className="mb-3 text-[13px] text-red-500">{error}</p> : null}

          <div className="flex justify-end border-t border-[var(--line)] pt-5">
            <button
              type="button"
              disabled={!canCustom}
              className="inline-flex h-9 items-center rounded-xl bg-[var(--ink)] px-4 text-[13px] font-medium text-[var(--on-brand)] hover:opacity-90 disabled:opacity-50"
              onClick={onSaveProvider}
            >
              {canCustom ? t('agent.providerSave') : t('agent.providerSaveMember')}
            </button>
          </div>
        </section>

        {providers.length ? (
          <section className="rounded-xl bg-[var(--account-card)] p-6 ring-1 ring-[var(--line)]">
            <h2 className="mb-4 text-[15px] font-semibold text-[var(--ink)]">
              {t('agent.providerSaved')}
            </h2>
            <ul className="flex flex-col gap-3">
              {platformRows.map((p) => {
                const children = childModelsOf(p.id);
                const adding = addModelForId === p.id;
                return (
                  <li
                    key={p.id}
                    className="rounded-lg bg-[var(--account-main)] px-3 py-2.5 ring-1 ring-[var(--line)]"
                  >
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[14px] font-medium text-[var(--ink)]">
                          {p.name}
                        </div>
                        <div className="truncate text-[12px] text-[var(--muted)]">
                          {p.baseUrl}
                          {p.apiKeyHint ? ` · ${p.apiKeyHint}` : ''}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="shrink-0 rounded-lg px-2 py-1 text-[12px] font-medium text-[var(--ink)] hover:bg-[var(--accent-soft)]"
                        onClick={() => (adding ? closeAddModel() : openAddModel(p.id))}
                      >
                        {adding ? t('common.cancel') : t('agent.providerAddPlatformModel')}
                      </button>
                      <button
                        type="button"
                        aria-label={t('common.delete')}
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]"
                        onClick={() => onRemove(p.id)}
                      >
                        <HiOutlineTrash className="h-4 w-4" />
                      </button>
                    </div>

                    {children.length ? (
                      <ul className="mt-2 space-y-1 border-t border-[var(--line)] pt-2">
                        {children.map((child) => (
                          <li
                            key={child.id}
                            className="flex items-center gap-2 rounded-md px-1.5 py-1"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-center gap-2">
                                <ModelBrandIcon
                                  model={{
                                    iconKey: child.iconKey,
                                    iconUrl: child.iconUrl,
                                    label: child.name,
                                    id: child.apiModel,
                                  }}
                                  size={16}
                                />
                                <span className="truncate text-[13px] text-[var(--ink)]">
                                  {child.name}
                                </span>
                                <span className="shrink-0 rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
                                  {t(customModelKindLabelKey(child.modelKind))}
                                </span>
                              </div>
                              <div className="truncate text-[11px] text-[var(--muted)]">
                                {child.apiModel}
                              </div>
                            </div>
                            <button
                              type="button"
                              aria-label={t('common.delete')}
                              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]"
                              onClick={() => onRemove(child.id)}
                            >
                              <HiOutlineTrash className="h-3.5 w-3.5" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    {adding ? (
                      <div className="mt-2 border-t border-[var(--line)] pt-2">
                        <AddPlatformModelFields
                          fieldClass={fieldClass}
                          selectFieldClass={selectFieldClass}
                          t={t}
                          apiId={addModelApiId}
                          name={addModelName}
                          iconKey={addModelIconKey}
                          iconUrl={addModelIconUrl}
                          kind={addModelKind}
                          onApiId={setAddModelApiId}
                          onName={setAddModelName}
                          onIconKey={setAddModelIconKey}
                          onIconUrl={setAddModelIconUrl}
                          onKind={setAddModelKind}
                        />
                        {addModelError ? (
                          <p className="mb-3 text-[12px] text-red-500">{addModelError}</p>
                        ) : null}
                        <div className="flex justify-end">
                          <button
                            type="button"
                            className="inline-flex h-8 items-center rounded-lg bg-[var(--ink)] px-3 text-[12px] font-medium text-[var(--on-brand)] hover:opacity-90"
                            onClick={() => onSavePlatformModel(p)}
                          >
                            {t('agent.providerAddPlatformModelSave')}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}

              {otherProviders.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-2 rounded-lg bg-[var(--account-main)] px-3 py-2.5 ring-1 ring-[var(--line)]"
                >
                  <ModelBrandIcon
                    model={{
                      iconKey: p.iconKey,
                      iconUrl: p.iconUrl,
                      label: p.name,
                      id: p.apiModel,
                    }}
                    size={22}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="truncate text-[14px] font-medium text-[var(--ink)]">
                        {p.name}
                      </div>
                      <span className="shrink-0 rounded-lg bg-[var(--accent-soft)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]">
                        {t(customModelKindLabelKey(p.modelKind))}
                      </span>
                    </div>
                    <div className="truncate text-[12px] text-[var(--muted)]">
                      {p.apiModel ? `${p.apiModel} · ` : ''}
                      {p.baseUrl}
                      {p.apiKeyHint ? ` · ${p.apiKeyHint}` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={t('common.delete')}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]"
                    onClick={() => onRemove(p.id)}
                  >
                    <HiOutlineTrash className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      {!onRequestUpgrade ? (
        <AccountSettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          initialTab="plans"
        />
      ) : null}
    </>
  );
}

export default memo(AgentModelsPanel);
