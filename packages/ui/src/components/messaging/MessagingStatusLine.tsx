import React from 'react';

/** One line under a list or form that carries its loading, empty or error state; it keeps its height when empty. */
export const MessagingStatusLine: React.FC<{ text: string | null; tone?: 'muted' | 'error'; action?: React.ReactNode }> = ({ text, tone = 'muted', action }) => (
  <div className="flex min-h-6 items-center gap-2 typography-meta">
    {text ? (
      <span className={tone === 'error' ? 'min-w-0 truncate text-[var(--status-error)]' : 'min-w-0 truncate text-muted-foreground'} title={text}>
        {text}
      </span>
    ) : null}
    {action}
  </div>
);
