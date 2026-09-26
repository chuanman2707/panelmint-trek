// Barrel for the local api adapters — the whole api surface of the app.
//
// Every kept domain runs on a Dexie-backed adapter here; `api/client.ts` is a
// pure `export * from './local'` so the import surface callers use never
// changed across the port. There is no axios instance and no hosted surface
// left to swap. Conventions: ./README.md.
export { tripsApi } from './trips'
export { daysApi } from './days'
export { dashboardApi } from './dashboard'
export { weatherApi } from './weather'
export { airportsApi } from './airports'
export { tagsApi } from './tags'
export { tripMembersApi } from './tripMembers'
export { configApi } from './config'
export { placesApi } from './places'
export { categoriesApi } from './categories'
export { mapsApi } from './maps'
export { assignmentsApi } from './assignments'
export { accommodationsApi } from './accommodations'
export { reservationsApi } from './reservations'
export { budgetApi } from './budget'
export { usersApi } from './users'
export { packingApi } from './packing'
export { todoApi } from './todos'
export { dayNotesApi } from './notes'
