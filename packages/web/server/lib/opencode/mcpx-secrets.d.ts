export interface SecretOutcome {
  status: number;
  body: unknown;
}

export declare const MCPX_SECRETS_ENTERPRISE_REFUSAL: { error: string; code: string };

export declare function listSecretRequests(): Promise<SecretOutcome>;
export declare function listSecrets(): Promise<SecretOutcome>;
export declare function declineSecretRequest(id: string | undefined): Promise<SecretOutcome>;
export declare function storeSecret(name: string | undefined, value: string | undefined): Promise<SecretOutcome>;
