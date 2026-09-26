// The api barrel. Every domain runs on the Dexie-backed adapters under
// `./local` — there is no server, no axios instance and no `/api/*` traffic.
export * from './local'
