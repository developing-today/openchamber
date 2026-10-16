import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { shouldDismissDropdown } from '@/components/ui/dropdown-navigation';
import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useI18n } from '@/lib/i18n';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { cn } from '@/lib/utils';
import { rankBranchesForQuery } from '@/lib/worktrees/branchSearch';

/** A branch as git names it (`remotes/origin/x` for a remote one) and as it is shown. */
export type PickedBranch = { value: string; label: string };

/** A titled group of choices shown above the branch lists. */
export type BranchPickerSection = { heading: string; branches: PickedBranch[] };

/** A pull request offered while the search is its number. */
type BranchPickerPullRequests = {
  heading: string;
  label: (number: number) => string;
  onPick: (number: number) => void;
};

type PickerRow = PickedBranch & { pullRequest?: number };
type PickerSection = { heading: string; rows: readonly PickerRow[] };

const PULL_REQUEST_QUERY = /^[#!]?(\d{1,9})$/;

/** The nearest scrolling ancestor; the mobile sheet scrolls itself, not the list. */
const findScrollableAncestor = (start: HTMLElement | null): HTMLElement | null => {
  let node = start;
  while (node && node !== document.body) {
    const { overflowY } = window.getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
};

/**
 * One branch choice, searchable: a dropdown on desktop, a sheet on mobile.
 * Matches rank first while searching; otherwise the leading sections, then
 * local branches, then remote ones. The New Worktree dialog uses it as a form
 * field; the composer's Auto-create worktree source uses the `inline` trigger
 * with its default and worktrees as leading sections and pull requests by number.
 */
export function NewWorktreeBranchPicker({
  value,
  valueLabel,
  placeholder,
  title,
  localBranches,
  remoteBranches,
  leadingSections = [],
  pullRequests,
  isLoading,
  isMobile,
  disabled = false,
  variant = 'field',
  onSelect,
}: {
  value: string;
  /** The trigger's text when the value is not what the user reads. */
  valueLabel?: string;
  placeholder: string;
  /** The mobile sheet's title, and the inline trigger's accessible name. */
  title: string;
  localBranches: string[];
  remoteBranches: string[];
  /** Choices above the branch lists, searched with them. */
  leadingSections?: readonly BranchPickerSection[];
  /** Offered while the search is a number; absent where a pull request is not a choice. */
  pullRequests?: BranchPickerPullRequests;
  isLoading: boolean;
  isMobile: boolean;
  /** Shown, but not applicable to the current choice. */
  disabled?: boolean;
  /** `inline` is the chrome-less trigger of the composer's target row. */
  variant?: 'field' | 'inline';
  onSelect: (branch: PickedBranch) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const desktopContentRef = React.useRef<HTMLDivElement | null>(null);
  const mobileListRef = React.useRef<HTMLDivElement | null>(null);

  const searching = query.trim().length > 0;
  const pullRequestNumber = pullRequests ? Number(PULL_REQUEST_QUERY.exec(query.trim())?.[1] ?? 0) : 0;
  const sections = React.useMemo((): PickerSection[] => {
    const ranked = rankBranchesForQuery({ localBranches, remoteBranches, query });
    if (searching) {
      const leading = leadingSections.map((section) => ({
        heading: section.heading,
        rows: rankByQuery(section.branches, query, (branch) => [branch.label]),
      }));
      const pullRequestSection = pullRequests && pullRequestNumber > 0
        ? [{ heading: pullRequests.heading, rows: [{ value: `pull-request:${pullRequestNumber}`, label: pullRequests.label(pullRequestNumber), pullRequest: pullRequestNumber }] }]
        : [];
      return [
        ...pullRequestSection,
        ...leading,
        { heading: t('session.newWorktree.matchingBranches'), rows: ranked.matching },
      ].filter((section) => section.rows.length > 0);
    }
    return [
      ...leadingSections.map((section) => ({ heading: section.heading, rows: section.branches })),
      { heading: t('session.newWorktree.localBranches'), rows: ranked.otherLocal.map((branch) => ({ value: branch, label: branch })) },
      { heading: t('session.newWorktree.remoteBranches'), rows: ranked.otherRemote.map((branch) => ({ value: `remotes/${branch}`, label: branch })) },
    ].filter((section) => section.rows.length > 0);
  }, [leadingSections, localBranches, pullRequestNumber, pullRequests, remoteBranches, query, searching, t]);

  // A new query starts the list from the top.
  React.useEffect(() => {
    if (!open) return;
    if (isMobile) {
      const scroller = findScrollableAncestor(mobileListRef.current);
      if (scroller) scroller.scrollTop = 0;
      return;
    }
    const list = desktopContentRef.current?.querySelector<HTMLElement>('[data-slot="command-list"]');
    if (list) list.scrollTop = 0;
  }, [open, query, isMobile]);

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery('');
  };
  const choose = (row: PickerRow) => {
    if (row.pullRequest !== undefined) pullRequests?.onPick(row.pullRequest);
    else onSelect({ value: row.value, label: row.label });
    changeOpen(false);
  };

  const hasChoices = localBranches.length > 0
    || remoteBranches.length > 0
    || leadingSections.some((section) => section.branches.length > 0);
  const status = isLoading
    ? t('session.newWorktree.loadingBranches')
    : !hasChoices && sections.length === 0
      ? t('session.newWorktree.noBranchesFound')
      : searching && sections.length === 0
        ? t('session.newWorktree.noMatchingBranches')
        : null;
  const shownValue = valueLabel ?? value;
  const triggerLabel = (
    <span className={cn('truncate', shownValue ? 'text-foreground' : 'text-muted-foreground')}>{shownValue || placeholder}</span>
  );
  // Rows in different sections may name the same branch (a worktree's branch is
  // also a local branch), so the list's own item value carries the section.
  const itemValue = (section: PickerSection, row: PickerRow) => `${section.heading}:${row.value}`;

  if (isMobile) {
    return (
      <>
        {variant === 'inline' ? (
          <button
            type="button"
            onClick={() => changeOpen(true)}
            disabled={disabled}
            aria-label={title}
            className="inline-flex h-7 min-w-0 max-w-[48vw] cursor-pointer items-center gap-1 rounded-lg px-1.5 typography-micro font-medium text-foreground/80 hover:bg-[var(--interactive-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon name="git-branch" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {triggerLabel}
            <Icon name="arrow-down-s" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => changeOpen(true)} disabled={disabled} className="h-8 w-full justify-between">
            {triggerLabel}
            <Icon name="git-branch" className="h-4 w-4 text-muted-foreground" />
          </Button>
        )}
        <MobileOverlayPanel open={open} title={title} onClose={() => changeOpen(false)}>
          <div className="space-y-4" ref={mobileListRef}>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('session.newWorktree.searchBranches')}
              className="h-8"
            />
            {status ? (
              <div className="px-2 py-8 text-center typography-small text-muted-foreground">{status}</div>
            ) : sections.map((section) => (
              <div key={section.heading} className="space-y-2">
                <div className="px-2 typography-small font-semibold text-foreground">{section.heading}</div>
                <div className="space-y-1">
                  {section.rows.map((row) => (
                    <button
                      key={row.value}
                      type="button"
                      onClick={() => choose(row)}
                      className={cn(
                        'w-full rounded-md px-3 py-2.5 text-start transition-colors',
                        value === row.value ? 'bg-interactive-selection text-interactive-selection-foreground' : 'hover:bg-interactive-hover',
                      )}
                    >
                      <span className="typography-small break-all">{row.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </MobileOverlayPanel>
      </>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={changeOpen}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        {variant === 'inline' ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={title}
            className="h-7 min-w-0 w-fit max-w-[42vw] justify-start gap-1 px-1.5 normal-case hover:bg-transparent data-[popup-open]:bg-transparent sm:max-w-[18rem]"
          >
            <Icon name="git-branch" className="size-3.5 shrink-0 text-muted-foreground" />
            {triggerLabel}
            <Icon name="arrow-down-s" className="size-4 shrink-0 opacity-50" />
          </Button>
        ) : (
          <button type="button" disabled={disabled} className={cn(dropdownTriggerVariants({ size: 'default' }), 'w-full max-w-full disabled:cursor-not-allowed disabled:opacity-50')}>
            {triggerLabel}
            <Icon name="arrow-down-s" className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        portalToBody
        className={cn(
          'flex max-h-[min(var(--available-height),24rem)] flex-col overflow-hidden p-0',
          variant === 'inline' ? 'w-72 max-w-[calc(100vw-2rem)]' : 'w-[var(--anchor-width)] min-w-[16rem]',
        )}
        ref={desktopContentRef}
      >
        <Command
          shouldFilter={false}
          // Keys stop here, after the list has used them to move and choose, so
          // the menu's own typeahead never steals them from the search field.
          // Escape goes on and closes the menu.
          onKeyDown={(event) => {
            if (!shouldDismissDropdown(event)) event.stopPropagation();
          }}
        >
          <CommandInput
            placeholder={t('session.newWorktree.searchBranches')}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList disableHorizontal>
            {status ? (
              <CommandEmpty>{status}</CommandEmpty>
            ) : sections.map((section, index) => (
              <React.Fragment key={section.heading}>
                {index > 0 ? <CommandSeparator /> : null}
                <CommandGroup heading={section.heading}>
                  {section.rows.map((row) => (
                    <CommandItem key={row.value} value={itemValue(section, row)} onSelect={() => choose(row)}>
                      <span className="typography-small break-all">{row.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </React.Fragment>
            ))}
          </CommandList>
        </Command>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
