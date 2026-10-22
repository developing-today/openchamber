import React from 'react';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { useUIStore } from '@/stores/useUIStore';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { updateDesktopSettings } from '@/lib/persistence';
import { opencodeClient } from '@/lib/opencode/client';
import { loadIntegrationCatalog, peekIntegrationCatalog, type IntegrationCatalog } from '@/lib/opencode/integration-catalog';
import { requiresProviderAuth } from './providerAvailability';
import { listConnectableProviders } from './connectableProviders';
import { ProviderConnectPicker } from './ProviderConnectPicker';
import {
  findIntegrationForProvider,
  isRouteProvider,
  providerHasCredentials,
  ROUTE_PROVIDER_NAME_KEY,
  shouldAutoOpenAuthPanel,
  shouldShowApiKeyAuth,
  shouldShowModelsSection,
  usesMachineCredentials,
  getCredentialConnections,
  getKeyMethod,
  getSignInMethods,
  getProviderConnections,
  getSignInIntegrationId,
  readProviderApiKeySetting,
  type CredentialConnection,
} from './providerAuth';
import { ProviderGrid } from './ProviderGrid';
import { ProviderModelsSection } from './ProviderModelsSection';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { ClassificationProvidersPage } from '@/components/sections/classification/ClassificationProvidersPage';
import { SettingsBackButton } from '@/components/sections/shared/SettingsCards';
import { ProviderAccounts } from './ProviderAccounts';
import { CustomProviderForm } from './CustomProviderForm';

import { ProviderOAuthMethods } from './ProviderOAuthMethods';
import { ProviderApiKeyForm, type IntegrationKeyRequest } from './ProviderApiKeyForm';
import {
  buildIntegrationKeyRequest,
  buildProviderUpsertRequest,
  storeKeyAfterConfigWrite,
  CUSTOM_PROVIDER_ID,
  isConfigDefinedCustomProvider,
  providerToEditFormState,
  resolveProviderConfigScope,
  storedProviderEntrySchema,
  type CustomProviderFormState,
  type CustomProviderPersistPlan,
  type ProviderConfigScope,
  type StoredProviderEntry,
} from './custom-provider-form';

// OpenCode owns the credential and announces the catalog change itself
// (`credential.updated` → catalog refresh); nothing to reload after it.
const connectIntegrationKey = async (request: IntegrationKeyRequest): Promise<void> => {
  await opencodeClient.getSdkClient().integration.connect.key(request);
};

const ADD_PROVIDER_ID = '__add_provider__';
/** Not an OpenCode provider id: the page for OpenChamber's own classification providers (Jev). */
const CLASSIFICATION_PAGE_ID = '__classification__';

/**
 * Says a provider is off. Nothing under it is locked: the model choices shown
 * under it can still be changed, and they apply again once the provider is
 * back on. A provider shown with no models (`hasModels` false) says only what
 * brings them back.
 */
const DisabledNotice: React.FC<{ hasModels: boolean }> = ({ hasModels }) => {
  const { t } = useI18n();
  return (
    <div className="oc-tile mb-6 flex items-start gap-2 rounded-lg p-3">
      <Icon name="pause" className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <p className="typography-meta text-foreground">
        {hasModels ? t('settings.providers.disabled.banner') : t('settings.providers.disabled.bannerNoModels')}
      </p>
    </div>
  );
};

interface ProviderSourceInfo {
  exists: boolean;
  path?: string | null;
}

interface ProviderSources {
  user: ProviderSourceInfo;
  project: ProviderSourceInfo;
  custom?: ProviderSourceInfo;
}

export const ProvidersPage: React.FC = () => {
  const { t } = useI18n();
  // Settings browses whichever project its own selector points at; the app
  // stays where it is.
  const settingsDirectory = useSettingsDirectory();
  const providers = useConfigStore((state) => selectProvidersForDirectory(state, settingsDirectory));
  // Which provider the page shows is its own state. The config store's
  // selectedProviderId belongs to the chat's model selection; sharing it made
  // Settings open on the chat's provider and marked the chat selection manual.
  const connectRequested = useUIStore((state) => state.settingsProvidersConnectRequested);
  const setConnectRequested = useUIStore((state) => state.setSettingsProvidersConnectRequested);
  const classificationRequested = useUIStore((state) => state.settingsProvidersClassificationRequested);
  const setClassificationRequested = useUIStore((state) => state.setSettingsProvidersClassificationRequested);
  const openRequested = useUIStore((state) => state.settingsProvidersOpenRequested);
  const setOpenRequested = useUIStore((state) => state.setSettingsProvidersOpenRequested);
  const [selectedProviderId, setSelectedProvider] = React.useState(() => (
    connectRequested ? ADD_PROVIDER_ID : classificationRequested ? CLASSIFICATION_PAGE_ID : openRequested ?? ''
  ));
  React.useEffect(() => {
    if (!connectRequested) return;
    setSelectedProvider(ADD_PROVIDER_ID);
    setConnectRequested(false);
  }, [connectRequested, setConnectRequested]);
  React.useEffect(() => {
    if (!classificationRequested) return;
    setSelectedProvider(CLASSIFICATION_PAGE_ID);
    setClassificationRequested(false);
  }, [classificationRequested, setClassificationRequested]);
  React.useEffect(() => {
    if (!openRequested) return;
    setSelectedProvider(openRequested);
    setOpenRequested(null);
  }, [openRequested, setOpenRequested]);
  const customProviderIcons = useUIStore((state) => state.customProviderIcons);
  const setCustomProviderIcon = useUIStore((state) => state.setCustomProviderIcon);

  // The app only loads providers for the project it is on; Settings has to ask
  // for the one it is looking at. Without a project that is the app's own.
  const loadProviders = useConfigStore((state) => state.loadProviders);
  React.useEffect(() => {
    void loadProviders({ directory: settingsDirectory, source: 'settings:providers' });
  }, [loadProviders, settingsDirectory]);

  // Starts from the list read earlier in this app session (prefetched at
  // startup or from the last visit), then reads it again below.
  const [catalog, setCatalog] = React.useState<IntegrationCatalog | null>(() => peekIntegrationCatalog());
  const [integrationsLoadFailed, setIntegrationsLoadFailed] = React.useState(false);
  const integrations = catalog?.integrations ?? null;
  // The store's list, read again on every visit: null until read, and where
  // the runtime has no OpenChamber server (VS Code).
  const disabledProviders = useConfigStore((state) => state.disabledProviderIds);
  const loadDisabledProviders = useConfigStore((state) => state.loadDisabledProviders);
  const setProviderDisabled = useConfigStore((state) => state.setProviderDisabled);
  React.useEffect(() => {
    void loadDisabledProviders();
  }, [loadDisabledProviders]);
  const handleProviderDisabled = React.useCallback(async (providerId: string, disabled: boolean) => {
    try {
      await setProviderDisabled(providerId, disabled, [settingsDirectory]);
      toast.success(disabled
        ? t('settings.providers.disabled.toast.disabled', { provider: providerId })
        : t('settings.providers.disabled.toast.enabled', { provider: providerId }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [setProviderDisabled, settingsDirectory, t]);
  // Only the first read blocks the credential forms; a re-read keeps showing
  // the methods already known.
  const authLoading = catalog === null && !integrationsLoadFailed;
  const [authBusyKey, setAuthBusyKey] = React.useState<string | null>(null);
  const [accountBusyId, setAccountBusyId] = React.useState<string | null>(null);
  const [modelQuery, setModelQuery] = React.useState('');
  const [candidateProviderId, setCandidateProviderId] = React.useState('');
  const [providerSources, setProviderSources] = React.useState<Record<string, ProviderSources>>({});
  // The config-file entry per provider; the edit form starts from it, not from
  // the live provider (which lacks `env` and carries generated reasoning levels).
  const [storedProviderConfigs, setStoredProviderConfigs] = React.useState<Record<string, StoredProviderEntry | null>>({});
  // Bumped after auth writes so the source snapshot is refetched even when the
  // selected provider id is unchanged (OAuth/API key success path).
  const [providerSourcesRevision, setProviderSourcesRevision] = React.useState(0);
  // Bumped after a credential write so the integration snapshot (which owns the
  // "connected" signal in v2) is refetched even when the selection is unchanged.
  const [integrationsRevision, setIntegrationsRevision] = React.useState(0);
  const [showAuthPanel, setShowAuthPanel] = React.useState(false);
  // An administrator turned on enterprise mode: providers come from the
  // OpenCode config, and the server refuses new ones and new keys.
  const enterpriseLocked = useEnterpriseMode();
  const [authPanelDismissedForId, setAuthPanelDismissedForId] = React.useState<string | null>(null);
  const [editingCustomProviderId, setEditingCustomProviderId] = React.useState<string | null>(null);
  const [editingCustomFormInitial, setEditingCustomFormInitial] = React.useState<CustomProviderFormState | null>(null);
  const [editingCustomScope, setEditingCustomScope] = React.useState<ProviderConfigScope | null>(null);
  const [customAuthFailureHint, setCustomAuthFailureHint] = React.useState<string | null>(null);
  const [lastCustomPersistId, setLastCustomPersistId] = React.useState<string | null>(null);
  const isAddMode = selectedProviderId === ADD_PROVIDER_ID;
  const isCustomCreateMode = isAddMode && candidateProviderId === CUSTOM_PROVIDER_ID;
  const isCustomEditMode = Boolean(
    editingCustomProviderId
    && selectedProviderId
    && editingCustomProviderId === selectedProviderId
    && !isAddMode,
  );

  React.useEffect(() => {
    // Auth methods drive which credential UI to show (API key vs OAuth). Keep
    // them loaded for the active provider view so OAuth-only plugins never fall
    // back to an API key form merely because methods were never fetched, and so
    // an already-listed provider can still offer re-authentication. The card
    // grid reads the same list for each provider's status, and the connect
    // page derives what can still be connected from it.
    let isMounted = true;

    const loadIntegrations = async () => {
      try {
        const next = await loadIntegrationCatalog();
        if (!isMounted) return;
        setCatalog(next);
        setIntegrationsLoadFailed(false);
      } catch (error) {
        if (!isMounted) return;
        console.error('Failed to load provider integrations:', error);
        // A list already on screen stays; only a page with none says it failed.
        setIntegrationsLoadFailed(true);
        toast.error(t('settings.providers.page.toast.authMethodsLoadFailed'));
      }
    };

    loadIntegrations();

    return () => {
      isMounted = false;
    };
  }, [integrationsRevision, t]);

  const connectedProviderIds = React.useMemo(
    () => new Set(providers.map((provider) => provider.id)),
    [providers]
  );

  const unconnectedProviders = React.useMemo(
    () => (catalog ? listConnectableProviders(catalog, connectedProviderIds) : null),
    [catalog, connectedProviderIds]
  );

  React.useEffect(() => {
    // A candidate requested from Classification providers arrives before the
    // list does; judge it only once there is a list to judge it against.
    if (selectedProviderId !== ADD_PROVIDER_ID || !unconnectedProviders || unconnectedProviders.length === 0) {
      return;
    }

    if (
      candidateProviderId
      && candidateProviderId !== CUSTOM_PROVIDER_ID
      && !unconnectedProviders.some((provider) => provider.id === candidateProviderId)
    ) {
      setCandidateProviderId('');
    }
  }, [selectedProviderId, candidateProviderId, unconnectedProviders]);

  React.useEffect(() => {
    if (selectedProviderId === ADD_PROVIDER_ID) {
      setShowAuthPanel(true);
      setAuthPanelDismissedForId(null);
      setEditingCustomProviderId(null);
      setEditingCustomFormInitial(null);
      setEditingCustomScope(null);
      setCustomAuthFailureHint(null);
      return;
    }

    setShowAuthPanel(false);
    setAuthPanelDismissedForId(null);
    if (editingCustomProviderId && editingCustomProviderId !== selectedProviderId) {
      setEditingCustomProviderId(null);
      setEditingCustomFormInitial(null);
      setEditingCustomScope(null);
      setCustomAuthFailureHint(null);
    }
  }, [selectedProviderId, editingCustomProviderId]);

  // Unauthenticated providers (OAuth-only plugins before login) should open the
  // auth panel instead of a false "Connected" summary. Respect an explicit Hide.
  React.useEffect(() => {
    if (!selectedProviderId || selectedProviderId === ADD_PROVIDER_ID || selectedProviderId === CLASSIFICATION_PAGE_ID) {
      return;
    }
    // The routes provider signs in to nothing, so it never opens the auth panel.
    if (isRouteProvider(selectedProviderId)) {
      return;
    }
    const sources = providerSources[selectedProviderId];
    if (!sources || integrations === null) {
      return;
    }
    const provider = providers.find((entry) => entry.id === selectedProviderId);
    const hasCreds = providerHasCredentials({
      connections: getProviderConnections(integrations, selectedProviderId),
      optionsApiKey: readProviderApiKeySetting(provider),
      machineCredentials: usesMachineCredentials(provider),
    });
    const isEditableCustomProvider = Boolean(
      provider && isConfigDefinedCustomProvider(provider, sources)
    );
    if (
      shouldAutoOpenAuthPanel({
        integrationsLoaded: true,
        hasCredentials: hasCreds,
        userDismissed: authPanelDismissedForId === selectedProviderId,
        isEditableCustomProvider,
      })
    ) {
      setShowAuthPanel(true);
    }
  }, [selectedProviderId, providerSources, providers, integrations, authPanelDismissedForId]);

  React.useEffect(() => {
    if (!selectedProviderId || selectedProviderId === ADD_PROVIDER_ID || selectedProviderId === CLASSIFICATION_PAGE_ID) {
      return;
    }

    let cancelled = false;

    const loadSources = async () => {
      try {
        // OpenChamber-only metadata endpoint: the SDK exposes provider data but
        // not local auth/source-file provenance used by this settings UI.
        const query = settingsDirectory ? `?directory=${encodeURIComponent(settingsDirectory)}` : '';
        const response = await runtimeFetch(`/api/provider/${encodeURIComponent(selectedProviderId)}/source${query}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error || t('settings.providers.page.toast.providerSourcesLoadFailed'));
        }

        const sources = (payload?.sources ?? payload?.data?.sources) as ProviderSources | undefined;
        if (!cancelled && sources) {
          setProviderSources((prev) => ({
            ...prev,
            [selectedProviderId]: sources,
          }));
          setStoredProviderConfigs((prev) => ({
            ...prev,
            // A missing or malformed entry falls back to live data in the form.
            [selectedProviderId]: storedProviderEntrySchema.safeParse(payload?.config ?? payload?.data?.config).data ?? null,
          }));
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load provider sources:', error);
        }
      }
    };

    loadSources();

    return () => {
      cancelled = true;
    };
  }, [selectedProviderId, providerSourcesRevision, settingsDirectory, t]);

  const refreshProviderSources = React.useCallback(() => {
    setProviderSourcesRevision((revision) => revision + 1);
  }, []);

  const refreshIntegrations = React.useCallback(() => {
    setIntegrationsRevision((revision) => revision + 1);
  }, []);

  const markAuthWriteSucceeded = React.useCallback((providerId: string) => {
    // Optimistically record a connection so a providers refresh that has not yet
    // landed cannot reopen the panel / hide models with a stale
    // "Credentials missing" summary before the integration refetch arrives.
    setCatalog((prev) => prev && {
      ...prev,
      integrations: prev.integrations.map((integration) => (
        integration.id === providerId && integration.connections.length === 0
          ? { ...integration, connections: [{ type: 'credential', id: `pending:${providerId}`, label: providerId, method: 'key' }] }
          : integration
      )),
    });
    setAuthPanelDismissedForId(null);
    setShowAuthPanel(false);
    setCandidateProviderId('');
    setSelectedProvider(providerId);
    refreshProviderSources();
    refreshIntegrations();
  }, [refreshIntegrations, refreshProviderSources, setSelectedProvider]);

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
  const selectedSources = selectedProviderId ? providerSources[selectedProviderId] : undefined;

  const handleSaveCustomProvider = async (plan: CustomProviderPersistPlan) => {
    const busyKey = `custom:${plan.providerID}`;
    setAuthBusyKey(busyKey);
    setLastCustomPersistId(plan.providerID);
    setCustomAuthFailureHint(null);

    try {
      // Config first: OpenCode registers a custom provider's key method only
      // once the provider is in its config, so the key follows the write.
      const keyRequest = buildIntegrationKeyRequest(plan);
      const upsertBody = buildProviderUpsertRequest(plan, {
        // Create defaults to user. Edit must rewrite the winning config layer
        // (custom > project > user) so project/custom providers are not copied
        // into a global user override.
        scope: editingCustomProviderId
          ? (editingCustomScope ?? resolveProviderConfigScope(providerSources[editingCustomProviderId]))
          : 'user',
      });
      const response = await runtimeFetch(`/api/provider${settingsDirectory ? `?directory=${encodeURIComponent(settingsDirectory)}` : ''}`, {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(upsertBody),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || t('settings.providers.page.toast.customProviderSaveFailed'));
      }
      if (keyRequest) {
        try {
          await storeKeyAfterConfigWrite(() => opencodeClient.getSdkClient().integration.connect.key(keyRequest));
        } catch (error) {
          setCustomAuthFailureHint(t('settings.providers.page.custom.authFailure.keyAfterConfig'));
          throw error;
        }
      }

      // Only a chosen icon is stored; "default" removes the entry so the
      // provider's own logo (or the generic fallback) shows again.
      const nextCustomProviderIcons = { ...useUIStore.getState().customProviderIcons };
      if (plan.icon) nextCustomProviderIcons[plan.providerID] = plan.icon;
      else delete nextCustomProviderIcons[plan.providerID];
      await updateDesktopSettings({ customProviderIcons: nextCustomProviderIcons });
      setCustomProviderIcon(plan.providerID, plan.icon);

      toast.success(t('settings.providers.page.toast.customProviderSaved', { provider: plan.name }));
      setCandidateProviderId('');
      setEditingCustomProviderId(null);
      setEditingCustomFormInitial(null);
      setEditingCustomScope(null);
      setCustomAuthFailureHint(null);
      setLastCustomPersistId(null);
      // OpenCode watches its config file and rebuilds the catalog on its own.
      markAuthWriteSucceeded(plan.providerID);
    } catch (error) {
      console.error('Failed to save custom provider:', error);
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t('settings.providers.page.toast.customProviderSaveFailed'),
      );
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleOAuthConnected = (providerId: string) => {
    setShowAuthPanel(false);
    // Optimistic mark + sources refetch so the page does not stick on a stale
    // "Credentials missing" summary while the providers refresh lands.
    markAuthWriteSucceeded(providerId);
  };

  const handleDisconnectProvider = async (providerId: string) => {
    const busyKey = `disconnect:${providerId}`;
    setAuthBusyKey(busyKey);

    try {
      // v2 keeps credentials in OpenCode, one record per stored login; the
      // provider is disconnected once every one of them is gone. Env-backed
      // connections are not removable from here — they live in the environment.
      const credentials = getCredentialConnections(
        findIntegrationForProvider(integrations ?? [], providerId),
      );
      const sdk = opencodeClient.getSdkClient();
      for (const credential of credentials) {
        await sdk.credential.remove({ credentialID: credential.id });
      }

      toast.success(t('settings.providers.page.toast.providerDisconnected'));
      setAuthPanelDismissedForId(null);
      refreshProviderSources();
      refreshIntegrations();
    } catch (error) {
      console.error('Failed to disconnect provider:', error);
      toast.error(t('settings.providers.page.toast.providerDisconnectFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleDisconnectCustomProvider = async (providerId: string) => {
    if (!providerId) {
      return;
    }
    await handleDisconnectProvider(providerId);
    setEditingCustomProviderId(null);
    setEditingCustomFormInitial(null);
    setEditingCustomScope(null);
    setCustomAuthFailureHint(null);
    setLastCustomPersistId(null);
    setCandidateProviderId('');
  };

  // Each account action waits for the server's answer and then rereads the
  // integration list; OpenCode owns which credential is active, so nothing is
  // flipped locally first.
  const runAccountAction = async (
    account: CredentialConnection,
    action: () => Promise<void>,
    messages: { success?: string; failure: string },
  ) => {
    setAccountBusyId(account.id);
    try {
      await action();
      if (messages.success) toast.success(messages.success);
    } catch (error) {
      console.error('Provider account action failed:', error);
      toast.error(messages.failure);
    } finally {
      setAccountBusyId(null);
      refreshIntegrations();
    }
  };

  const handleActivateAccount = (account: CredentialConnection) => runAccountAction(
    account,
    async () => {
      await opencodeClient.getSdkClient().credential.activate({ credentialID: account.id });
    },
    {
      success: t('settings.providers.accounts.toast.switched', { account: account.label }),
      failure: t('settings.providers.accounts.toast.switchFailed'),
    },
  );

  const handleRenameAccount = (account: CredentialConnection, label: string) => runAccountAction(
    account,
    async () => {
      await opencodeClient.getSdkClient().credential.update({ credentialID: account.id, label });
    },
    { failure: t('settings.providers.accounts.toast.renameFailed') },
  );

  const handleRemoveAccount = (account: CredentialConnection) => runAccountAction(
    account,
    async () => {
      await opencodeClient.getSdkClient().credential.remove({ credentialID: account.id });
      refreshProviderSources();
    },
    {
      success: t('settings.providers.accounts.toast.removed'),
      failure: t('settings.providers.accounts.toast.removeFailed'),
    },
  );

  const backToGrid = () => {
    setCandidateProviderId('');
    setSelectedProvider('');
  };
  const backButton = <SettingsBackButton label={t('settings.providers.page.back')} onClick={backToGrid} />;


  // A classification source that needs a key links to the provider holding it:
  // its own page when OpenCode already lists it, the connect form otherwise.
  const openProviderForKey = (providerId: string) => {
    if (providers.some((provider) => provider.id === providerId)) {
      setSelectedProvider(providerId);
      return;
    }
    setCandidateProviderId(providerId);
    setSelectedProvider(ADD_PROVIDER_ID);
  };

  if (selectedProviderId === CLASSIFICATION_PAGE_ID) {
    return <ClassificationProvidersPage titleLeading={backButton} onOpenProvider={openProviderForKey} />;
  }

  // Enterprise mode: the way in stays hidden and the server refuses anyway.
  if (isAddMode && !enterpriseLocked && !candidateProviderId) {
    return (
      <SettingsPageLayout
        title={t('settings.providers.page.connect.title')}
        titleLeading={backButton}
        showSaveStatus={false}
      >
        <ProviderConnectPicker
          providers={unconnectedProviders}
          loadFailed={integrationsLoadFailed}
          onSelect={setCandidateProviderId}
          onSelectCustom={() => setCandidateProviderId(CUSTOM_PROVIDER_ID)}
        />
      </SettingsPageLayout>
    );
  }

  if (isAddMode && !enterpriseLocked) {
    // A chosen provider: back returns to the picker, not to the grid.
    const candidateBackButton = (
      <SettingsBackButton label={t('settings.providers.page.back')} onClick={() => setCandidateProviderId('')} />
    );
    const candidateName = unconnectedProviders?.find((provider) => provider.id === candidateProviderId)?.name ?? candidateProviderId;
    return (
      <SettingsPageLayout
        title={isCustomCreateMode ? t('settings.providers.page.connect.title') : candidateName}
        titleLeading={isCustomCreateMode ? candidateBackButton : (
          <span className="flex items-center gap-2">
            {candidateBackButton}
            <ProviderLogo providerId={candidateProviderId} className="h-5 w-5 shrink-0" />
          </span>
        )}
        showSaveStatus={false}
      >
          {isCustomCreateMode ? (
            <CustomProviderForm
              mode="create"
              existingProviderIDs={connectedProviderIds}
              busy={authBusyKey?.startsWith('custom:') ?? false}
              authFailureHint={customAuthFailureHint}
              onCancel={() => {
                setCandidateProviderId('');
                setCustomAuthFailureHint(null);
                setLastCustomPersistId(null);
              }}
              onDisconnect={
                customAuthFailureHint && lastCustomPersistId
                  ? () => void handleDisconnectCustomProvider(lastCustomPersistId)
                  : undefined
              }
              onSubmit={handleSaveCustomProvider}
            />
          ) : (
            <SettingsSection
              title={t('settings.providers.page.auth.title')}
              divider={false}
              settingsItem="providers.auth"
              contentClassName="space-y-4"
            >
              {authLoading ? (
                <p className="typography-meta text-muted-foreground">{t('settings.providers.page.auth.loadingMethods')}</p>
              ) : (
                <>
                  {(() => {
                    const candidateIntegration = findIntegrationForProvider(integrations ?? [], candidateProviderId);
                    const candidateSignInMethods = getSignInMethods(
                      findIntegrationForProvider(integrations ?? [], getSignInIntegrationId(candidateProviderId)),
                    );
                    const showApiKey = shouldShowApiKeyAuth(candidateIntegration);

                    return (
                      <>
                        {showApiKey ? (
                          <ProviderApiKeyForm
                            key={candidateProviderId}
                            integrationId={candidateProviderId}
                            keyMethod={getKeyMethod(candidateIntegration)}
                            connectKey={connectIntegrationKey}
                            onSaved={() => markAuthWriteSucceeded(candidateProviderId)}
                          />
                        ) : null}

                        {candidateSignInMethods.length > 0 ? (
                          <ProviderOAuthMethods
                            key={candidateProviderId}
                            integrationId={getSignInIntegrationId(candidateProviderId)}
                            methods={candidateSignInMethods}
                            onConnected={() => handleOAuthConnected(candidateProviderId)}
                            className={cn(showApiKey && 'border-t border-[var(--surface-subtle)] pt-2')}
                          />
                        ) : null}
                      </>
                    );
                  })()}
                </>
              )}
            </SettingsSection>
          )}
      </SettingsPageLayout>
    );
  }

  const selectedDisabled = selectedProviderId !== '' && (disabledProviders?.includes(selectedProviderId) ?? false);
  // Off and on live in one list, so this button, the card and the list at the
  // bottom of the grid always agree. Models stay editable while a provider is off.
  const disableToggle = disabledProviders !== null && selectedProviderId !== '' && !isAddMode && selectedProviderId !== CLASSIFICATION_PAGE_ID ? (
    <Button
      variant="outline"
      size="xs"
      className="!font-normal"
      title={selectedDisabled ? undefined : t('settings.providers.disabled.disableHint')}
      onClick={() => void handleProviderDisabled(selectedProviderId, !selectedDisabled)}
    >
      {selectedDisabled ? t('settings.providers.disabled.enable') : t('settings.providers.disabled.disable')}
    </Button>
  ) : null;

  if (!selectedProvider) {
    // A turned-off provider is in no catalog, since the store leaves it out
    // while OpenCode still lists it, yet it keeps its own page, so its card and
    // the list at the bottom lead somewhere that says it is off.
    if (!selectedDisabled) {
      return (
        <ProviderGrid
          providers={providers}
          integrations={integrations}
          directory={settingsDirectory}
          onSelect={setSelectedProvider}
          onConnect={() => setSelectedProvider(ADD_PROVIDER_ID)}
          onOpenClassification={() => setSelectedProvider(CLASSIFICATION_PAGE_ID)}
          disabledProviders={disabledProviders}
          onSetProviderDisabled={(providerId, disabled) => void handleProviderDisabled(providerId, disabled)}
        />
      );
    }
    const unlistedName = findIntegrationForProvider(integrations ?? [], selectedProviderId)?.name || selectedProviderId;
    // OpenCode drops a turned-off provider's models from its catalog with the
    // provider, so the models its OpenCode config entry names are the ones whose
    // show and hide choice can still be changed here. A provider whose entry
    // names none shows the notice alone, saying what brings its models back.
    const configuredModels = Object.entries(storedProviderConfigs[selectedProviderId]?.models ?? {})
      .map(([id, model]) => ({ id, name: model.name?.trim() || id }));
    return (
      <SettingsPageLayout
        title={unlistedName}
        titleLeading={(
          <span className="flex items-center gap-2">
            {backButton}
            <ProviderLogo providerId={selectedProviderId} className="h-5 w-5 shrink-0" />
          </span>
        )}
        description={<span className="typography-settings-description font-mono text-muted-foreground">{selectedProviderId}</span>}
        headerEnd={disableToggle}
        showSaveStatus={false}
      >
        <DisabledNotice hasModels={configuredModels.length > 0} />
        {configuredModels.length > 0 ? (
          <ProviderModelsSection
            providerId={selectedProviderId}
            models={configuredModels}
            title={t('settings.providers.page.models.title')}
            query={modelQuery}
            onQueryChange={setModelQuery}
          />
        ) : null}
      </SettingsPageLayout>
    );
  }

  const providerModels = Array.isArray(selectedProvider.models) ? selectedProvider.models : [];
  const selectedIntegration = findIntegrationForProvider(integrations ?? [], selectedProvider.id);
  const signInMethods = getSignInMethods(
    findIntegrationForProvider(integrations ?? [], getSignInIntegrationId(selectedProvider.id)),
  );
  const showApiKeyAuth = shouldShowApiKeyAuth(selectedIntegration);
  const integrationsLoaded = integrations !== null;
  const sourcesLoaded = Boolean(selectedSources);
  const isEditableCustomProvider = sourcesLoaded
    && isConfigDefinedCustomProvider(selectedProvider, selectedSources);
  const hasCredentials = providerHasCredentials({
    connections: getProviderConnections(integrations ?? [], selectedProvider.id),
    optionsApiKey: readProviderApiKeySetting(selectedProvider),
    machineCredentials: usesMachineCredentials(selectedProvider),
  });
  const authStatusIncomplete = requiresProviderAuth(integrationsLoaded, hasCredentials, isEditableCustomProvider);
  const routeProvider = isRouteProvider(selectedProvider.id);
  const showModelsSection = routeProvider
    ? providerModels.length > 0
    : shouldShowModelsSection({
      modelCount: providerModels.length,
      integrationsLoaded,
      hasCredentials,
      isEditableCustomProvider,
    });
  const providerConnections = getProviderConnections(integrations ?? [], selectedProvider.id) ?? [];
  // Requests go through one integration only: the provider's own, or the one it
  // is bound to (OpenCode Go moves to the Console once you are signed in there).
  // Its first credential is the active account; credentials stored under the
  // other integration stay listed so they can be removed, but are not in use.
  const usedIntegrationId = selectedProvider.integrationID ?? selectedProvider.id;
  const usedCredentials = getCredentialConnections(findIntegrationForProvider(integrations ?? [], usedIntegrationId));
  const activeAccountId = usedCredentials[0]?.id ?? null;
  const unusedAccountIds = new Set(
    providerConnections.flatMap((connection) => (
      connection.type === 'credential' && !usedCredentials.some((used) => used.id === connection.id)
        ? [connection.id]
        : []
    )),
  );
  const configSources = [
    selectedSources?.user.exists ? t('settings.providers.page.connectionDetails.source.userConfig') : null,
    selectedSources?.project.exists ? t('settings.providers.page.connectionDetails.source.projectConfig') : null,
    selectedSources?.custom?.exists ? t('settings.providers.page.connectionDetails.source.customConfig') : null,
  ].filter((source): source is string => source !== null);
  const providerTitleLeading = (
    <span className="flex items-center gap-2">
      {backButton}
      <ProviderLogo providerId={selectedProvider.id} className="h-5 w-5 shrink-0" />
    </span>
  );
  const providerDescription = (
    <span className="typography-settings-description text-muted-foreground">
      <span className="font-mono">{selectedProvider.id}</span>
      {configSources.length > 0
        ? <> · {t('settings.providers.page.configuredIn', { sources: configSources.join(', ') })}</>
        : null}
    </span>
  );

  if (isCustomEditMode && isEditableCustomProvider && editingCustomFormInitial) {
    return (
      <SettingsPageLayout
        title={selectedProvider.name || selectedProvider.id}
        titleLeading={providerTitleLeading}
        description={providerDescription}
        headerEnd={disableToggle}
        showSaveStatus={false}
      >
        <CustomProviderForm
          mode="edit"
          existingProviderIDs={connectedProviderIds}
          initialValues={editingCustomFormInitial}
          allowExistingAuth={hasCredentials || !sourcesLoaded}
          busy={authBusyKey?.startsWith('custom:') ?? false}
          authFailureHint={customAuthFailureHint}
          onCancel={() => {
            setEditingCustomProviderId(null);
            setEditingCustomFormInitial(null);
            setEditingCustomScope(null);
            setCustomAuthFailureHint(null);
            setLastCustomPersistId(null);
          }}
          onDisconnect={() => void handleDisconnectCustomProvider(selectedProvider.id)}
          onSubmit={handleSaveCustomProvider}
        />
      </SettingsPageLayout>
    );
  }

  return (
    <SettingsPageLayout
      title={routeProvider ? t(ROUTE_PROVIDER_NAME_KEY) : selectedProvider.name || selectedProvider.id}
      titleLeading={providerTitleLeading}
      description={providerDescription}
      headerEnd={disableToggle}
      showSaveStatus={false}
    >
      {routeProvider ? null : (
      <SettingsSection
        title={t('settings.providers.accounts.title')}
        info={t('settings.providers.accounts.info')}
        divider={false}
        headerAction={(
          <div className="flex items-center gap-1">
            {isEditableCustomProvider && !enterpriseLocked ? (
              <Button
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => {
                  setCustomAuthFailureHint(null);
                  setEditingCustomFormInitial(providerToEditFormState(
                    selectedProvider,
                    storedProviderConfigs[selectedProvider.id] ?? null,
                    customProviderIcons[selectedProvider.id],
                  ));
                  setEditingCustomScope(resolveProviderConfigScope(selectedSources));
                  setEditingCustomProviderId(selectedProvider.id);
                }}
              >
                {t('settings.providers.page.actions.edit')}
              </Button>
            ) : null}
            {enterpriseLocked ? null : (
            <Button
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => {
                const nextOpen = !showAuthPanel;
                setShowAuthPanel(nextOpen);
                setAuthPanelDismissedForId(nextOpen ? null : selectedProvider.id);
              }}
            >
              {showAuthPanel ? (
                t('settings.providers.page.actions.cancel')
              ) : (
                <>
                  <Icon name="add" className="size-3.5" />
                  {providerConnections.length > 0
                    ? t('settings.providers.accounts.add')
                    : t('settings.providers.page.actions.connect')}
                </>
              )}
            </Button>
            )}
          </div>
        )}
        settingsItem="providers.auth"
        contentClassName="space-y-4"
      >
        {providerConnections.length > 0 ? (
          <ProviderAccounts
            connections={providerConnections}
            activeId={activeAccountId}
            unusedIds={unusedAccountIds}
            busyId={accountBusyId}
            onActivate={(account) => void handleActivateAccount(account)}
            onRename={(account, label) => void handleRenameAccount(account, label)}
            onRemove={(account) => void handleRemoveAccount(account)}
          />
        ) : !showAuthPanel && authStatusIncomplete ? (
          <div className="flex items-center gap-1.5 py-1.5">
            <Icon name="alert" className="w-4 h-4 text-[var(--status-warning)] shrink-0" />
            <span className="typography-ui-label text-foreground">{t('settings.providers.page.auth.incomplete')}</span>
            {showApiKeyAuth ? <SettingsInfoHint>{t('settings.providers.page.auth.incompleteHint')}</SettingsInfoHint> : null}
          </div>
        ) : null}

        {enterpriseLocked ? (
          <p className="typography-meta text-muted-foreground">{t('settings.providers.enterpriseMode')}</p>
        ) : null}

        {!showAuthPanel || enterpriseLocked ? null : authLoading ? (
          <div className="py-1.5 typography-meta text-muted-foreground">{t('settings.providers.page.auth.loadingMethods')}</div>
        ) : (
          <div
            className={cn(
              'space-y-4',
              providerConnections.length > 0 && 'oc-tile rounded-xl p-4',
            )}
          >
            {showApiKeyAuth ? (
              <ProviderApiKeyForm
                key={selectedProvider.id}
                integrationId={selectedProvider.id}
                keyMethod={getKeyMethod(selectedIntegration)}
                connectKey={connectIntegrationKey}
                onSaved={() => markAuthWriteSucceeded(selectedProvider.id)}
              />
            ) : null}

            {signInMethods.length > 0 && (
              <ProviderOAuthMethods
                key={selectedProvider.id}
                integrationId={getSignInIntegrationId(selectedProvider.id)}
                methods={signInMethods}
                onConnected={() => handleOAuthConnected(selectedProvider.id)}
                className={cn(showApiKeyAuth && 'border-t border-[var(--surface-subtle)] pt-2')}
              />
            )}
          </div>
        )}
      </SettingsSection>
      )}

      {showModelsSection ? (
        <ProviderModelsSection
          providerId={selectedProvider.id}
          models={providerModels}
          title={routeProvider ? t('settings.providers.routes.poolsTitle') : t('settings.providers.page.models.title')}
          info={routeProvider ? t('settings.providers.routes.poolsInfo') : undefined}
          query={modelQuery}
          onQueryChange={setModelQuery}
        />
      ) : null}
    </SettingsPageLayout>
  );
};
