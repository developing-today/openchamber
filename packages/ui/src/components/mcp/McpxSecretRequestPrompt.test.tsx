import { afterEach, expect, spyOn, test } from 'bun:test';
import type { ReactElement } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import type { McpxSecretRequest } from '@/lib/mcpxSecrets';

import type { McpxSecretEntry } from './McpxSecretRequestPrompt';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 404 }));
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { McpxSecretRequestDialog, McpxSecretRequestPrompt } = await import('./McpxSecretRequestPrompt');
const { useEnterprisePolicyStore } = await import('@/stores/useEnterprisePolicyStore');

const setEnterpriseMode = async (enterpriseMode: boolean) => {
  await act(async () => { useEnterprisePolicyStore.setState({ enterpriseMode }); });
};

const REQUEST: McpxSecretRequest = {
  id: 'req_42',
  server: 'github',
  secrets: ['GITHUB_TOKEN', 'GITHUB_ORG'],
  status: 'pending',
  createdAt: '2026-10-11T09:00:00Z',
  message: 'github needs GITHUB_TOKEN and GITHUB_ORG',
};
const RESOLVED: McpxSecretRequest = { ...REQUEST, id: 'req_41', status: 'resolved' };

let root: Root | null = null;
const mount = async (element: ReactElement) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(element); });
};

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  document.body.innerHTML = '';
  fetchSpy.mockImplementation(async () => new Response(null, { status: 404 }));
});

const passwordFields = () => [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')];
const buttonNamed = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
  .find((button) => button.textContent?.trim() === name);
const titleText = () => document.querySelector('[data-slot="dialog-title"]')?.textContent ?? null;
const alertText = () => document.querySelector('[role="alert"]')?.textContent ?? null;

const setValue = async (field: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('Missing input value setter');
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const submitForm = async () => {
  const form = document.querySelector('form');
  if (!form) throw new Error('Missing form');
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
};

const click = async (button: HTMLButtonElement | undefined) => {
  if (!button) throw new Error('Missing button');
  await act(async () => { button.click(); });
};

// Lets the pending fetches and the state they set run to completion.
const settle = async () => {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
};

const dialog = (overrides: Partial<Parameters<typeof McpxSecretRequestDialog>[0]> = {}) => (
  <I18nProvider>
    <McpxSecretRequestDialog
      request={REQUEST}
      busy={false}
      error={null}
      onSubmit={() => undefined}
      onDecline={() => undefined}
      onDismiss={() => undefined}
      {...overrides}
    />
  </I18nProvider>
);

test('shows the server, each secret name, and a password field per secret', async () => {
  await mount(dialog());
  expect(titleText()).toBe('github needs secrets');
  const fields = passwordFields();
  expect(fields.length).toBe(2);
  for (const field of fields) {
    expect(field.getAttribute('autocomplete')).toBe('off');
    expect(field.getAttribute('spellcheck')).toBe('false');
  }
  expect(document.body.textContent).toContain('GITHUB_TOKEN');
  expect(document.body.textContent).toContain('GITHUB_ORG');
});

test('submit hands over trimmed values in secret order and clears every field', async () => {
  const submitted: McpxSecretEntry[][] = [];
  await mount(dialog({ onSubmit: (entries) => { submitted.push(entries); } }));
  const [token, org] = passwordFields();
  await setValue(token, '  ghp_example  ');
  await setValue(org, 'acme');
  await submitForm();
  expect(submitted).toEqual([[
    { name: 'GITHUB_TOKEN', value: 'ghp_example' },
    { name: 'GITHUB_ORG', value: 'acme' },
  ]]);
  expect(passwordFields().map((field) => field.value)).toEqual(['', '']);
});

test('save stays disabled until every secret has a value', async () => {
  await mount(dialog());
  const [token, org] = passwordFields();
  expect(buttonNamed('Save secrets')?.disabled).toBe(true);
  await setValue(token, 'ghp_example');
  expect(buttonNamed('Save secrets')?.disabled).toBe(true);
  await setValue(org, '   ');
  expect(buttonNamed('Save secrets')?.disabled).toBe(true);
  await setValue(org, 'acme');
  expect(buttonNamed('Save secrets')?.disabled).toBe(false);
});

test('decline reports the request and leaves the typed values alone', async () => {
  let declined = 0;
  await mount(dialog({ onDecline: () => { declined += 1; } }));
  const [token] = passwordFields();
  await setValue(token, 'ghp_example');
  await click(buttonNamed('Decline'));
  expect(declined).toBe(1);
  expect(passwordFields()[0].value).toBe('ghp_example');
});

test('a busy dialog locks its fields and both buttons', async () => {
  await mount(dialog({ busy: true }));
  expect(passwordFields().every((field) => field.disabled)).toBe(true);
  expect(buttonNamed('Decline')?.disabled).toBe(true);
  expect(buttonNamed('Save secrets')?.disabled).toBe(true);
});

test('shows a save error in the dialog', async () => {
  await mount(dialog({ error: 'Could not save GITHUB_TOKEN. The fields are cleared, so enter the values again.' }));
  expect(alertText()).toBe('Could not save GITHUB_TOKEN. The fields are cleared, so enter the values again.');
});

test('the prompt shows the oldest pending request and skips resolved ones', async () => {
  fetchSpy.mockImplementation(async (input) => {
    if (String(input).endsWith('/api/mcpx/secret-requests')) return Response.json({ requests: [RESOLVED, REQUEST] });
    return new Response(null, { status: 404 });
  });
  await mount(<I18nProvider><McpxSecretRequestPrompt /></I18nProvider>);
  await settle();
  expect(titleText()).toBe('github needs secrets');
  expect(passwordFields().length).toBe(2);
});

test('saving sends one PUT per secret, then waits for a fresh list before the prompt closes', async () => {
  const sent: Array<{ method: string; path: string; body: string }> = [];
  let pending: McpxSecretRequest[] = [REQUEST];
  fetchSpy.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/api/mcpx/')) {
      sent.push({ method, path: url.slice(url.indexOf('/api/')), body: String(init?.body ?? '') });
    }
    if (method === 'PUT') return Response.json({ name: 'GITHUB_TOKEN', set: true, source: 'runtime' });
    return Response.json({ requests: pending });
  });
  await mount(<I18nProvider><McpxSecretRequestPrompt /></I18nProvider>);
  await settle();
  const [token, org] = passwordFields();
  await setValue(token, 'ghp_example');
  await setValue(org, 'acme');
  // The daemon resolves the request once both values are set.
  pending = [];
  await submitForm();
  await settle();

  expect(sent.map((call) => `${call.method} ${call.path}`)).toEqual([
    'GET /api/mcpx/secret-requests',
    'PUT /api/mcpx/secrets/GITHUB_TOKEN',
    'PUT /api/mcpx/secrets/GITHUB_ORG',
    'GET /api/mcpx/secret-requests',
  ]);
  expect(sent.filter((call) => call.method === 'PUT').map((call) => call.body))
    .toEqual(['{"value":"ghp_example"}', '{"value":"acme"}']);
  expect(sent.some((call) => call.path.includes('ghp_example'))).toBe(false);
  expect(titleText()).toBeNull();
});

test('a failed save names the secret, leaves the fields cleared, and makes no further writes', async () => {
  const puts: string[] = [];
  fetchSpy.mockImplementation(async (input, init) => {
    const url = String(input);
    if ((init?.method ?? 'GET') === 'PUT') {
      puts.push(url);
      return new Response(JSON.stringify({ error: 'mcpx daemon did not store the secret' }), { status: 502 });
    }
    return Response.json({ requests: [REQUEST] });
  });
  await mount(<I18nProvider><McpxSecretRequestPrompt /></I18nProvider>);
  await settle();
  const [token, org] = passwordFields();
  await setValue(token, 'ghp_example');
  await setValue(org, 'acme');
  await submitForm();
  await settle();

  expect(puts.length).toBe(1);
  expect(alertText()).toBe('Could not save GITHUB_TOKEN. The fields are cleared, so enter the values again.');
  expect(alertText()).not.toContain('ghp_example');
  expect(passwordFields().map((field) => field.value)).toEqual(['', '']);
  expect(buttonNamed('Save secrets')?.disabled).toBe(true);
});

test('decline deletes the request, and the prompt moves on to the next pending one', async () => {
  const OTHER: McpxSecretRequest = { ...REQUEST, id: 'req_43', server: 'linear', secrets: ['LINEAR_KEY'] };
  const sent: string[] = [];
  let pending: McpxSecretRequest[] = [REQUEST, OTHER];
  fetchSpy.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/api/mcpx/')) sent.push(`${method} ${url.slice(url.indexOf('/api/'))}`);
    if (method === 'DELETE') {
      pending = pending.filter((request) => request.id !== REQUEST.id);
      return Response.json({ id: REQUEST.id, status: 'declined' });
    }
    return Response.json({ requests: pending });
  });
  await mount(<I18nProvider><McpxSecretRequestPrompt /></I18nProvider>);
  await settle();
  expect(titleText()).toBe('github needs secrets');

  await click(buttonNamed('Decline'));
  await settle();
  expect(sent).toEqual([
    'GET /api/mcpx/secret-requests',
    'DELETE /api/mcpx/secret-requests/req_42',
    'GET /api/mcpx/secret-requests',
  ]);
  expect(titleText()).toBe('linear needs secrets');
});

test('a runtime switch drops the prompt, so a secret never goes to the runtime that asked for it', async () => {
  let switched = false;
  fetchSpy.mockImplementation(async (input) => {
    if (!String(input).endsWith('/api/mcpx/secret-requests')) return new Response(null, { status: 404 });
    // The new runtime has not answered yet, so only the switch can clear the prompt.
    if (switched) return new Promise<Response>(() => undefined);
    return Response.json({ requests: [REQUEST] });
  });
  await mount(<I18nProvider><McpxSecretRequestPrompt /></I18nProvider>);
  await settle();
  expect(titleText()).toBe('github needs secrets');

  // The runtime-switch event name is private to runtime-switch.ts.
  switched = true;
  await act(async () => {
    window.dispatchEvent(new CustomEvent('openchamber:runtime-endpoint-changed', { detail: {} }));
  });
  await settle();
  expect(titleText()).toBeNull();
});

test('in enterprise mode the prompt stays away and never asks the daemon for requests', async () => {
  await setEnterpriseMode(true);
  const callsBefore = fetchSpy.mock.calls.length;
  try {
    await mount(<I18nProvider><McpxSecretRequestPrompt /></I18nProvider>);
    await settle();
    expect(titleText()).toBeNull();
    const mcpxCalls = fetchSpy.mock.calls.slice(callsBefore).filter(([input]) => String(input).includes('/api/mcpx/'));
    expect(mcpxCalls).toEqual([]);
  } finally {
    await setEnterpriseMode(false);
  }
});

test('turning enterprise mode on closes a prompt that is already open', async () => {
  fetchSpy.mockImplementation(async () => Response.json({ requests: [REQUEST] }));
  await mount(<I18nProvider><McpxSecretRequestPrompt /></I18nProvider>);
  await settle();
  expect(titleText()).toBe('github needs secrets');

  try {
    await setEnterpriseMode(true);
    await settle();
    expect(titleText()).toBeNull();
  } finally {
    await setEnterpriseMode(false);
  }
});
