import React, { useEffect, useState } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  SettingsCard,
  SettingsCardIcon,
  SettingsCardPill,
} from '@/components/sections/shared/SettingsCards';

interface McpxNamespace {
  namespace: string;
  tools?: number;
  sharing?: string;
  scope?: string;
  state?: string;
  description?: string;
}

interface McpxStatus {
  daemon?: {
    running: boolean;
    pid: number;
    uptime?: string;
    endpoint?: string;
    socket?: string;
  };
  namespaces?: McpxNamespace[];
}

export const McpxDashboard: React.FC = () => {
  const [status, setStatus] = useState<McpxStatus | null>(null);
  const [namespaces, setNamespaces] = useState<McpxNamespace[]>([]);
  const [selectedNs, setSelectedNs] = useState<string | null>(null);
  const [types, setTypes] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/mcpx/status');
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
      const nsRes = await fetch('/api/mcpx/namespaces');
      if (nsRes.ok) {
        const nsData = await nsRes.json();
        setNamespaces(Array.isArray(nsData) ? nsData : nsData.namespaces || []);
      }
    } catch (err) {
      setError((err as { message?: string } | null)?.message || 'Failed to connect to mcpx daemon');
    } finally {
      setLoading(false);
    }
  };

  const fetchTypes = async (ns: string) => {
    setSelectedNs(ns);
    try {
      const res = await fetch(`/api/mcpx/types?namespace=${encodeURIComponent(ns)}`);
      if (res.ok) {
        const data = await res.json();
        setTypes(typeof data.types === 'string' ? data.types : JSON.stringify(data.types, null, 2));
      }
    } catch {
      setTypes('Failed to load types');
    }
  };

  useEffect(() => {
    void fetchStatus();
  }, []);

  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="flex items-center justify-between border-b pb-4">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon name="server" className="size-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-tight">mcpx Native Daemon & Tool Fleet</h2>
            <p className="text-xs text-muted-foreground">
              Standing gateway with persistent background pools, ghost tools, and isolated subagent sessions
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <SettingsCardPill tone={status ? 'success' : 'neutral'}>
            {status ? 'Daemon Online' : 'Checking'}
          </SettingsCardPill>
          <Button variant="outline" size="sm" onClick={() => void fetchStatus()} disabled={loading}>
            <Icon name="refresh" className={`size-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {namespaces.map((ns) => (
          <SettingsCard
            key={ns.namespace}
            icon={<SettingsCardIcon name="code" />}
            title={ns.namespace}
            subtitle={`${ns.tools ?? 0} tools · ${ns.sharing ?? 'shared'} (${ns.scope ?? 'global'})`}
            badges={
              <SettingsCardPill tone="success">
                {ns.state || 'ready'}
              </SettingsCardPill>
            }
            footer={
              <div className="flex items-center justify-between w-full text-xs">
                <span className="text-muted-foreground">{ns.description || 'MCP Namespace'}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    void fetchTypes(ns.namespace);
                  }}
                >
                  View Types
                </Button>
              </div>
            }
            onOpen={() => void fetchTypes(ns.namespace)}
          />
        ))}
      </div>

      {selectedNs ? (
        <div className="mt-4 rounded-lg border bg-card p-4">
          <div className="flex items-center justify-between pb-2 border-b">
            <h3 className="font-mono text-sm font-semibold text-foreground">
              TypeScript Signatures: {selectedNs}
            </h3>
            <Button variant="ghost" size="sm" onClick={() => setSelectedNs(null)}>
              Close
            </Button>
          </div>
          <pre className="mt-3 max-h-96 overflow-auto font-mono text-xs text-muted-foreground whitespace-pre-wrap bg-muted/40 p-3 rounded">
            {types || 'Loading...'}
          </pre>
        </div>
      ) : null}
    </div>
  );
};
