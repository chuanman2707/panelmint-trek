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
export { weatherApi } from './weather'
export { airportsApi } from './airports'
export { tagsApi } from './tags'
export { tripMembersApi } from './tripMembers'
export { shareApi } from './share'
export { configApi } from './config'
export { placesApi } from './places'
export { categoriesApi } from './categories'
export { mapsApi } from './maps'
export { assignmentsApi } from './assignments'
export { accommodationsApi } from './accommodations'
export { reservationsApi } from './reservations'
