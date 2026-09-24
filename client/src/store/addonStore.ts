import { create } from 'zustand'

interface Addon {
  id: string
  name: string
  description?: string
  type: string
  icon: string
  enabled: boolean
  config?: Record<string, unknown>
  fields?: Array<{
    key: string
    label: string
    input_type: string
    placeholder?: string | null
    required: boolean
    secret: boolean
    settings_key?: string | null
    payload_key?: string | null
    sort_order: number
  }>
}

/**
 * The addon set is static now — there is no server to toggle them. Packing and
 * budget are the two trip addons PanelMint keeps; everything else (documents,
 * collab, roadtrip, journey, integrations…) is cut and stays off, which is also
 * what hides their UI entry points.
 */
const STATIC_ADDONS: Addon[] = [
  { id: 'packing', name: 'Lists', type: 'trip', icon: 'ListChecks', enabled: true },
  { id: 'budget', name: 'Costs', type: 'trip', icon: 'Wallet', enabled: true },
]

interface AddonState {
  addons: Addon[]
  bagTracking: boolean
  loaded: boolean
  loadAddons: () => Promise<void>
  isEnabled: (id: string) => boolean
}

export const useAddonStore = create<AddonState>((set, get) => ({
  addons: STATIC_ADDONS,
  // The bag feature was an app_settings flag, not an addon row — bags stay on.
  bagTracking: true,
  loaded: true,

  // Kept for the boot path and settings screens that still call it — there is
  // nothing left to fetch, so it just re-asserts the static set. Seeded extras
  // (a test's roadtrip row, say) survive: merging rather than replacing is what
  // lets an opt-in feature stay testable without a feed behind it.
  loadAddons: async () => {
    set(s => ({
      loaded: true,
      bagTracking: true,
      addons: [
        ...STATIC_ADDONS,
        ...s.addons.filter(a => !STATIC_ADDONS.some(sa => sa.id === a.id)),
      ],
    }))
  },

  isEnabled: (id: string) => {
    if (id === 'memories') {
      return get().addons.some(a => a.type === 'photo_provider' && a.enabled)
    }
    return get().addons.some(a => a.id === id && a.enabled)
  },
}))
