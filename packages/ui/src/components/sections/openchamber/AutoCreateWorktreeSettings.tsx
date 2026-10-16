import React from 'react';
import {
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_OPTION_STACK_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SettingsCheckboxRow,
  SettingsControlGroup,
  SettingsFieldRow,
  SettingsRadioGroup,
  SettingsRadioOption,
  SettingsSection,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n, type I18nKey } from '@/lib/i18n';
import {
  PULL_REQUEST_WORKTREE_MODES,
  WORKTREE_START_FROM_OPTIONS,
  WORKTREE_START_PLACES,
  type PullRequestWorktreeMode,
  type WorktreeStartFrom,
  type WorktreeStartPlace,
} from '@/lib/worktrees/worktreeStartSource';
import {
  DEFAULT_PULL_REQUEST_BRANCH_TEMPLATE,
  DEFAULT_WORKTREE_BRANCH_TEMPLATE,
  isBranchTemplate,
  type BranchTemplateKind,
} from '@/lib/worktrees/branchNameTemplate';
import { useConfigStore } from '@/stores/useConfigStore';

const START_FROM_LABEL_KEYS = {
  'project-root': 'settings.openchamber.autoCreateWorktree.option.projectRoot',
  'remote-default': 'settings.openchamber.autoCreateWorktree.option.remoteDefault',
} satisfies Record<WorktreeStartFrom, I18nKey>;

const OVERRIDE_LABEL_KEYS = {
  'project-root': 'settings.openchamber.autoCreateWorktree.overrides.projectRoot',
  'remote-default': 'settings.openchamber.autoCreateWorktree.overrides.remoteDefault',
} satisfies Record<WorktreeStartFrom, I18nKey>;

const PLACE_LABEL_KEYS = {
  autoCreate: 'settings.openchamber.autoCreateWorktree.place.autoCreate',
  quick: 'settings.openchamber.autoCreateWorktree.place.quick',
  dialog: 'settings.openchamber.autoCreateWorktree.place.dialog',
  parallel: 'settings.openchamber.autoCreateWorktree.place.parallel',
  handoff: 'settings.openchamber.autoCreateWorktree.place.handoff',
  agent: 'settings.openchamber.autoCreateWorktree.place.agent',
} satisfies Record<WorktreeStartPlace, I18nKey>;

const PULL_REQUEST_LABEL_KEYS = {
  'check-out': 'settings.openchamber.autoCreateWorktree.pullRequest.checkOut',
  'branch-off': 'settings.openchamber.autoCreateWorktree.pullRequest.branchOff',
} satisfies Record<PullRequestWorktreeMode, I18nKey>;

/** The Select value for "follow the default"; a colon cannot start a start-from value. */
const USE_DEFAULT_VALUE = ':default';

const isWorktreeStartFrom = (value: string): value is WorktreeStartFrom => (
  WORKTREE_START_FROM_OPTIONS.some((option) => option === value)
);

/**
 * A branch name template. It is saved when the field is left with a usable
 * template; an empty field restores the default, and an unusable one says why
 * and keeps the saved template.
 */
const BranchTemplateField: React.FC<{
  kind: BranchTemplateKind;
  settingsItem: string;
  label: string;
  description: string;
  value: string;
  fallback: string;
  onSave: (template: string) => void;
}> = ({ kind, settingsItem, label, description, value, fallback, onSave }) => {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState(value);
  const [invalid, setInvalid] = React.useState(false);
  React.useEffect(() => {
    setDraft(value);
    setInvalid(false);
  }, [value]);

  const commit = () => {
    const template = draft.trim() || fallback;
    if (!isBranchTemplate(template, kind)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(template);
    if (template !== value) onSave(template);
  };

  return (
    <SettingsStackedField settingsItem={settingsItem} label={label} description={description}>
      <Input
        className="h-8 min-w-0"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') commit(); }}
        placeholder={fallback}
        aria-label={label}
        aria-invalid={invalid}
        spellCheck={false}
      />
      {/* A reserved line, so a message never moves the fields below it. */}
      <p className="min-h-4 typography-meta text-[var(--status-error)]">
        {invalid ? t('settings.openchamber.autoCreateWorktree.branchName.invalid') : null}
      </p>
    </SettingsStackedField>
  );
};

/**
 * The same switch the new-session draft shows next to its branch selector,
 * where new worktrees start, per place, how their branches are named, and how
 * a pull request becomes one.
 */
export const AutoCreateWorktreeSettings: React.FC = () => {
  const { t } = useI18n();
  const enabled = useConfigStore((state) => state.settingsAutoCreateWorktree);
  const setEnabled = useConfigStore((state) => state.setSettingsAutoCreateWorktree);
  const startFrom = useConfigStore((state) => state.settingsWorktreeStartFrom);
  const setStartFrom = useConfigStore((state) => state.setSettingsWorktreeStartFrom);
  const overrides = useConfigStore((state) => state.settingsWorktreeStartFromOverrides);
  const setOverride = useConfigStore((state) => state.setSettingsWorktreeStartFromOverride);
  const pullRequestMode = useConfigStore((state) => state.settingsPullRequestWorktree);
  const setPullRequestMode = useConfigStore((state) => state.setSettingsPullRequestWorktree);
  const branchTemplate = useConfigStore((state) => state.settingsWorktreeBranchTemplate);
  const setBranchTemplate = useConfigStore((state) => state.setSettingsWorktreeBranchTemplate);
  const pullRequestBranchTemplate = useConfigStore((state) => state.settingsPullRequestBranchTemplate);
  const setPullRequestBranchTemplate = useConfigStore((state) => state.setSettingsPullRequestBranchTemplate);

  return (
    <SettingsSection title={t('settings.openchamber.autoCreateWorktree.title')}>
      <div className={SETTINGS_OPTION_STACK_CLASS}>
        <SettingsCheckboxRow
          settingsItem="sessions.auto-create-worktree"
          checked={enabled}
          onChange={setEnabled}
          label={t('settings.openchamber.autoCreateWorktree.field.enable')}
          info={t('settings.openchamber.autoCreateWorktree.field.enableInfo')}
        />
        <SettingsControlGroup
          settingsItem="sessions.worktree-start-from"
          title={t('settings.openchamber.autoCreateWorktree.field.startFrom')}
          info={t('settings.openchamber.autoCreateWorktree.field.startFromInfo')}
        >
          <SettingsRadioGroup aria-label={t('settings.openchamber.autoCreateWorktree.field.startFrom')}>
            {WORKTREE_START_FROM_OPTIONS.map((option) => (
              <SettingsRadioOption
                key={option}
                selected={startFrom === option}
                onSelect={() => setStartFrom(option)}
                label={t(START_FROM_LABEL_KEYS[option])}
              />
            ))}
          </SettingsRadioGroup>
        </SettingsControlGroup>
        <SettingsControlGroup
          settingsItem="sessions.worktree-start-overrides"
          title={t('settings.openchamber.autoCreateWorktree.overrides.title')}
          info={t('settings.openchamber.autoCreateWorktree.overrides.info')}
        >
          {WORKTREE_START_PLACES.map((place) => {
            const label = t(PLACE_LABEL_KEYS[place]);
            const override = overrides[place];
            return (
              <SettingsFieldRow key={place} label={label}>
                <Select
                  value={override ?? USE_DEFAULT_VALUE}
                  onValueChange={(value) => setOverride(place, isWorktreeStartFrom(value) ? value : null)}
                >
                  <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={label}>
                    <SelectValue>
                      {override
                        ? t(OVERRIDE_LABEL_KEYS[override])
                        : t('settings.openchamber.autoCreateWorktree.overrides.useDefault')}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={USE_DEFAULT_VALUE}>
                      {t('settings.openchamber.autoCreateWorktree.overrides.useDefault')}
                    </SelectItem>
                    {WORKTREE_START_FROM_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>{t(OVERRIDE_LABEL_KEYS[option])}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsFieldRow>
            );
          })}
        </SettingsControlGroup>
        <SettingsControlGroup
          settingsItem="sessions.pull-request-worktree"
          title={t('settings.openchamber.autoCreateWorktree.pullRequest.title')}
          info={t('settings.openchamber.autoCreateWorktree.pullRequest.info')}
        >
          <SettingsRadioGroup aria-label={t('settings.openchamber.autoCreateWorktree.pullRequest.title')}>
            {PULL_REQUEST_WORKTREE_MODES.map((mode) => (
              <SettingsRadioOption
                key={mode}
                selected={pullRequestMode === mode}
                onSelect={() => setPullRequestMode(mode)}
                label={t(PULL_REQUEST_LABEL_KEYS[mode])}
              />
            ))}
          </SettingsRadioGroup>
        </SettingsControlGroup>
        <SettingsControlGroup
          title={t('settings.openchamber.autoCreateWorktree.branchName.title')}
          info={t('settings.openchamber.autoCreateWorktree.branchName.info')}
          contentClassName={SETTINGS_FIELDS_STACK_CLASS}
        >
          <BranchTemplateField
            kind="worktree"
            settingsItem="sessions.worktree-branch-template"
            label={t('settings.openchamber.autoCreateWorktree.branchName.worktree')}
            description={t('settings.openchamber.autoCreateWorktree.branchName.worktreeVariables')}
            value={branchTemplate}
            fallback={DEFAULT_WORKTREE_BRANCH_TEMPLATE}
            onSave={setBranchTemplate}
          />
          <BranchTemplateField
            kind="pull-request"
            settingsItem="sessions.pull-request-branch-template"
            label={t('settings.openchamber.autoCreateWorktree.branchName.pullRequest')}
            description={t('settings.openchamber.autoCreateWorktree.branchName.pullRequestVariables')}
            value={pullRequestBranchTemplate}
            fallback={DEFAULT_PULL_REQUEST_BRANCH_TEMPLATE}
            onSave={setPullRequestBranchTemplate}
          />
        </SettingsControlGroup>
      </div>
    </SettingsSection>
  );
};
