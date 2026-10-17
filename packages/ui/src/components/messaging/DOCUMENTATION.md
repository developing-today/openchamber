# Messages

`MessagingPanel` shows the person's inbox, topic threads, session chains and
logs. OpenCode owns the records. `stores/useMessagingStore.ts` keeps the
current tab, filters and loaded pages across panel remounts. Requests and
delivered-message decoding belong to `lib/opencode/messaging.ts`.

## Visibility and refreshes

Desktop context panels mount only the selected Messages panel. The mobile
drawer keeps visited panels mounted and passes `active` to the panel. Every
read effect follows that flag, so a closed drawer keeps its drafts without
reading in the background.

An active panel registers with `mountView`. Message events mark loaded slices
stale and batch refreshes while at least one view is active. Closing the last
view cancels its timer and retains the stale slices for reopening. A view's
own fresh read clears its pending refresh. Runtime switches retire requests
and clear the cache.

Topic settings initialize when the dialog opens. A refreshed topic updates
the displayed participant information without replacing an open form's draft.

## Runtime coverage

| Runtime | Entry point |
| --- | --- |
| Web | Messages context panel and Messaging Settings |
| Electron | Shared web panel and Settings through its backend |
| VS Code | Delivered-message chat rows; no Messages panel or Messaging Settings |
| Hosted mobile | Messages workspace drawer tab and Messaging Settings |
| Capacitor mobile | Same drawer and Settings through the connected server |

Notifications and event routing are described in `sync/DOCUMENTATION.md`.
Settings persistence is described in `components/sections/DOCUMENTATION.md`.
