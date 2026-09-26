import { externalHandlers } from './external';

// PanelMint has no backend, so no `/api/*` handlers are registered: the point
// of MSW here is that a handler for a `/api/*` request simply does not exist —
// if code still emits one, the request-logging tests observe it. What remains
// covers genuinely external services (e.g. Wikimedia) that local adapters or
// enrichment code may legitimately touch.
export const defaultHandlers = [...externalHandlers];
