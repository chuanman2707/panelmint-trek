// Barrel for the local api adapters — the end-state surface of api/client.ts.
//
// A domain lands here as its adapter is implemented:
//     export { tripsApi } from './trips'
// and `client.ts` swaps that domain's axios object for
//     export { tripsApi } from './local'
// — the import surface callers see never changes. Once every kept domain is
// swapped, client.ts shrinks to `export * from './local'` and the axios
// instance is deleted (plan task A9). Conventions: ./README.md.
export { tripsApi } from './trips'
export { daysApi } from './days'
export { dashboardApi } from './dashboard'
