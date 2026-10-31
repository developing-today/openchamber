import { deleteQuotaCredential, readQuotaCredential, writeQuotaCredential } from './store.js';

const clean = (value) => typeof value === 'string' && !/[\r\n]/.test(value) ? value.trim() : '';

export const normalizers = {
  'exe-dev': (value) => {
    const usageToken = clean(value?.usageToken);
    return usageToken ? { usageToken } : null;
  },
  cursor: (value) => {
    const accessToken = clean(value?.accessToken);
    const refreshToken = clean(value?.refreshToken);
    return accessToken || refreshToken ? { accessToken, refreshToken } : null;
  },
  zenmux: (value) => {
    const platformApiKey = clean(value?.platformApiKey);
    return platformApiKey ? { platformApiKey } : null;
  },
  opendesign: (value) => {
    const cookieInput = clean(value?.cookie);
    const workspaceId = clean(value?.workspaceId);
    if (!cookieInput || !workspaceId) return null;
    // Accept the cookie header value as copied from the browser, or a bare
    // session token, which is stored under its Better Auth cookie name.
    const cookie = cookieInput.includes('better-auth')
      ? cookieInput
      : `better-auth.session_token=${cookieInput}`;
    return { cookie, workspaceId };
  },
};

// Provider ids arrive from route segments. Only the registry's own keys name a
// provider: inherited members such as `constructor` or `toString` are not
// normalizers, and `__proto__` is not a provider.
export const getCredentialNormalizer = (providerId) => (
  Object.hasOwn(normalizers, providerId) ? normalizers[providerId] : null
);

export const readManagedCredential = (providerId) => {
  const normalize = getCredentialNormalizer(providerId);
  return normalize ? readQuotaCredential(providerId, normalize) : null;
};

export const writeManagedCredential = (providerId, value) => {
  const credential = getCredentialNormalizer(providerId)?.(value);
  if (!credential) throw new Error('Invalid credential');
  writeQuotaCredential(providerId, credential);
  return getManagedCredentialStatus(providerId);
};

export const getManagedCredentialStatus = (providerId) => {
  const credential = readManagedCredential(providerId);
  if (!credential) return { configured: false };
  if (providerId === 'cursor') return { configured: true, hasRefreshToken: Boolean(credential.refreshToken), secretMasked: '••••••••' };
  return { configured: true, secretMasked: '••••••••' };
};

export const deleteManagedCredential = (providerId) => deleteQuotaCredential(providerId);
