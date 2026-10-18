// The tray submenu drops "Allow always" for a permission that carries no save
// patterns (#4698). The tray rebuilds its menu only when `trayMenuKey` changes,
// so the flag has to be part of that signature too, or a snapshot whose only
// delta is `canSave` leaves the previous submenu on screen.
import { describe, expect, test } from 'bun:test';

import { buildTrayMenuTemplate, trayMenuKey } from './tray-menu.mjs';

const permission = (id, canSave) => ({
  kind: 'permission', id, sessionId: 's1', sessionTitle: 'Session',
  label: `bash: ${id}`, openSessionId: 's1', openDirectory: '/repo', canSave,
});

const snapshotWith = (...approvals) => ({ instanceName: 'OpenChamber', sessions: [], approvals });

const submenuLabels = (snapshot, id) => buildTrayMenuTemplate(snapshot, { onAction: () => {}, statusIcons: {} })
  .filter((row) => Array.isArray(row.submenu) && String(row.label).includes(id))
  .flatMap((row) => row.submenu.filter((item) => item.label).map((item) => item.label));

describe('tray approval submenu', () => {
  test('offers "Allow always" only when the request can be remembered', () => {
    const snapshot = snapshotWith(permission('savable', true), permission('one-off', false));

    expect(submenuLabels(snapshot, 'savable')).toEqual(['Allow once', 'Allow always', 'Deny', 'Open in app']);
    expect(submenuLabels(snapshot, 'one-off')).toEqual(['Allow once', 'Deny', 'Open in app']);
  });

  test('the menu key changes when canSave is the only change, so the submenu never goes stale', () => {
    const savable = trayMenuKey(snapshotWith(permission('p1', true)));
    const oneOff = trayMenuKey(snapshotWith(permission('p1', false)));

    expect(oneOff).not.toBe(savable);
    expect(trayMenuKey(snapshotWith(permission('p1', false)))).toBe(oneOff);
  });
});

// A subagent's request is answered from the top-level session above it, whose
// composer docks every request in its tree; the reply still goes to the
// subagent that asked, and the row still names it.
describe('tray approvals from a nested subagent', () => {
  const fromGrandchild = (overrides) => ({
    id: 'p1', kind: 'permission', sessionId: 'grandchild', sessionTitle: 'Level two', label: 'bash: echo ok',
    openSessionId: 'root', openDirectory: '/repo', canSave: false, ...overrides,
  });
  const menuFor = (...approvals) => {
    const actions = [];
    const template = buildTrayMenuTemplate(snapshotWith(...approvals), { onAction: (action) => actions.push(action), statusIcons: {} });
    const row = (label) => template.find((item) => String(item.label).includes(label));
    return { actions, row };
  };

  test('"Open in app" and a question open the root, while the answer goes to the subagent', () => {
    const { actions, row } = menuFor(fromGrandchild(), fromGrandchild({ id: 'f1', kind: 'form', label: 'Pick a layout' }));
    const permissionRow = row('bash: echo ok');

    permissionRow.submenu.find((item) => item.label === 'Allow once').click();
    permissionRow.submenu.find((item) => item.label === 'Open in app').click();
    row('Pick a layout').click();

    expect(permissionRow.label).toContain('Level two');
    expect(actions).toEqual([
      { type: 'respond-permission', sessionId: 'grandchild', id: 'p1', response: 'once' },
      { type: 'focus-session', sessionId: 'root', directory: '/repo' },
      { type: 'focus-session', sessionId: 'root', directory: '/repo' },
    ]);
  });

  test('the menu key changes when only where a request opens changes', () => {
    expect(trayMenuKey(snapshotWith(fromGrandchild({ openSessionId: 'grandchild' }))))
      .not.toBe(trayMenuKey(snapshotWith(fromGrandchild())));
  });

  test('a snapshot from an older version without an open target opens the session that asked', () => {
    const { actions, row } = menuFor(fromGrandchild({ openSessionId: undefined, openDirectory: undefined, directory: '/older' }));

    row('bash: echo ok').submenu.find((item) => item.label === 'Open in app').click();

    expect(actions).toEqual([{ type: 'focus-session', sessionId: 'grandchild', directory: '/older' }]);
  });
});
