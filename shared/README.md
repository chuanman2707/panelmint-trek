# @trek/shared

Single source of truth for PanelMint's domain contracts, expressed as [Zod](https://zod.dev)
schemas, plus all i18n locales. Consumed by the client (`@trek/client`): the local API
adapters in `client/src/api/local/` parse requests/responses with these schemas so the
shapes match what the hosted server used to return.

## Rules

- **One folder per domain**: `src/<domain>/<domain>.schema.ts` (+ `.spec.ts`).
- Domain-agnostic building blocks live in `src/common/`.
- Schemas are the source of truth; client types are *inferred* from them
  (`z.infer<typeof schema>`), never hand-duplicated.

## Consumption (dev)

The client resolves `@trek/shared` to this package's built `dist/` — run
`npm run build` here before client typecheck/tests after changing a schema or locale.
