import { z } from 'zod';

import { isEnterpriseMode } from '../../web/server/lib/enterprise-mode.js';
import {
  MCPX_SECRETS_ENTERPRISE_REFUSAL,
  declineSecretRequest,
  listSecretRequests,
  listSecrets,
  storeSecret,
  type SecretOutcome,
} from '../../web/server/lib/opencode/mcpx-secrets.js';
import type { BridgeRequest, BridgeResponse } from './bridge';

// The fields the secret messages carry, parsed from the payload. Anything else is ignored.
const secretFields = z.object({
  requestId: z.string().optional(),
  name: z.string().optional(),
  value: z.string().optional(),
});
type SecretFields = z.infer<typeof secretFields>;

const secretOperations = new Map<string, (fields: SecretFields) => Promise<SecretOutcome>>([
  ['api:mcpx/secret-requests', () => listSecretRequests()],
  ['api:mcpx/secrets', () => listSecrets()],
  ['api:mcpx/secrets:store', ({ name, value }) => storeSecret(name, value)],
  ['api:mcpx/secret-requests:decline', ({ requestId }) => declineSecretRequest(requestId)],
]);

/**
 * The MCP secret prompt's routes, answered the way the web server answers them
 * (`opencode/mcpx-routes.js`). The webview shim turns the outcome into the HTTP
 * status and body. Enterprise mode refuses every one of them.
 */
export async function handleMcpxBridgeMessage(message: BridgeRequest): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;
  const operation = secretOperations.get(type);
  if (!operation) return null;
  const parsed = secretFields.safeParse(payload);
  const fields: SecretFields = parsed.success ? parsed.data : {};
  const outcome = isEnterpriseMode()
    ? { status: 403, body: MCPX_SECRETS_ENTERPRISE_REFUSAL }
    : await operation(fields);
  return { id, type, success: true, data: outcome };
}
