import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

const secretRequestSchema = z.object({
  id: z.string(),
  server: z.string(),
  secrets: z.array(z.string()),
  status: z.enum(['pending', 'resolved', 'declined']),
  createdAt: z.string(),
  message: z.string(),
});

const secretRequestsSchema = z.object({
  requests: z.array(secretRequestSchema),
});

export type McpxSecretRequest = z.infer<typeof secretRequestSchema>;

/** The requests the daemon still waits on, in the order it lists them. */
export const fetchPendingSecretRequests = async (): Promise<McpxSecretRequest[]> => {
  const response = await runtimeFetch('/api/mcpx/secret-requests');
  if (!response.ok) throw new Error(`Failed to load secret requests (${response.status})`);
  const { requests } = secretRequestsSchema.parse(await response.json());
  return requests.filter((request) => request.status === 'pending');
};

/** Stores one value. The value goes in the request body only, and the error names the secret, never its value. */
export const putMcpxSecret = async (name: string, value: string): Promise<void> => {
  const response = await runtimeFetch(`/api/mcpx/secrets/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  if (!response.ok) throw new Error(`Failed to save ${name} (${response.status})`);
};

export const declineSecretRequest = async (id: string): Promise<void> => {
  const response = await runtimeFetch(`/api/mcpx/secret-requests/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`Failed to decline secret request (${response.status})`);
};
