import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PlPlaceSearch from '../../../../src/mobile/screens/trip/sheets/PlPlaceSearch'
import type { TripPlanner } from '../../../../src/mobile/screens/trip/MTripShell'
import { mapsApi } from '../../../../src/api/client'
import { LocalApiError } from '../../../../src/api/local/helpers'
import { useAuthStore } from '../../../../src/store/authStore'
import { buildPlanner } from '../../../helpers/mobileTrip'
import { fireEvent, render, screen, waitFor } from '../../../helpers/render'
import { resetAllStores, seedStore } from '../../../helpers/store'

// FE-MOB-PLSRCH-001 to FE-MOB-PLSRCH-022b
// planner.t echoes the key, so labels/toasts are asserted as their keys.

const LOUVRE = {
  name: 'Louvre Museum',
  address: 'Rue de Rivoli, Paris',
  lat: 48.8606,
  lng: 2.3376,
  google_place_id: 'ChIJ_louvre',
  google_ftid: '0x47e:0x1',
  osm_id: 'W7444,',
  website: 'https://louvre.fr',
  phone: '+33 1',
}

const SUGGESTION = { placeId: 'sug-1', mainText: 'Louvre', secondaryText: 'Paris, France' }

/**
 * mapsApi is the local facade over the browser-side provider clients — there is
 * no /api/maps route left to intercept, so calls are stubbed at the module
 * boundary and their argument tuples stand in for the old request bodies:
 *   autocomplete(input, language, locationBias, signal, session)
 *   search(query, language, center, provider)
 */
function mockAutocomplete(suggestions: unknown[] = [SUGGESTION]) {
  return vi.mocked(mapsApi.autocomplete).mockResolvedValue({ suggestions: suggestions as never, source: 'osm' })
}

function mockSearch(places: unknown[] = [LOUVRE]) {
  return vi.mocked(mapsApi.search).mockResolvedValue({ places: places as never, source: 'osm' })
}

/**
 * The index answers with the wrong place; only a search sent to Google on
 * purpose answers with the right one. The real source strings, so the test
 * pins what the line under the list actually switches on.
 */
function mockGoogleRetry() {
  return vi.mocked(mapsApi.search).mockImplementation(async (_q, _lang, _center, provider) =>
    provider === 'google'
      ? { places: [{ name: 'Tokyo Station', address: 'Chiyoda', lat: 35.68, lng: 139.77 }], source: 'google' }
      : { places: [{ name: 'Weigh station', address: 'Ritzville', lat: 47.1, lng: -118.4 }], source: 'trek-places+openstreetmap' })
}

function setup(plannerOverrides: Partial<TripPlanner> = {}, locationBias?: Parameters<typeof PlPlaceSearch>[0]['locationBias']) {
  const onPick = vi.fn()
  const onResolvingChange = vi.fn()
  const planner = buildPlanner(plannerOverrides)
  const view = render(
    <PlPlaceSearch planner={planner} locationBias={locationBias} onPick={onPick} onResolvingChange={onResolvingChange} />,
  )
  const input = screen.getByPlaceholderText('places.mapsSearchPlaceholder')
  return { ...view, planner, onPick, onResolvingChange, input }
}

describe('PlPlaceSearch', () => {
  beforeEach(() => {
    resetAllStores()
    // Empty defaults so no test reaches the real provider clients; a test that
    // cares about a call re-stubs it with mockAutocomplete/mockSearch above.
    vi.spyOn(mapsApi, 'autocomplete').mockResolvedValue({ suggestions: [], source: 'osm' })
    vi.spyOn(mapsApi, 'search').mockResolvedValue({ places: [], source: 'osm' })
    vi.spyOn(mapsApi, 'details').mockResolvedValue({ place: null })
    vi.spyOn(mapsApi, 'resolveUrl').mockRejectedValue(new LocalApiError(400, 'Could not extract coordinates from URL'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('FE-MOB-PLSRCH-001: stays quiet below two characters', async () => {
    const autocomplete = mockAutocomplete()
    const { input } = setup()
    fireEvent.change(input, { target: { value: 'L' } })
    await new Promise(r => setTimeout(r, 450))
    expect(autocomplete).not.toHaveBeenCalled()
    expect(screen.queryByText('Louvre')).not.toBeInTheDocument()
  })

  it('FE-MOB-PLSRCH-002: debounces the autocomplete and lists both suggestion lines', async () => {
    const autocomplete = mockAutocomplete()
    const { input } = setup()
    fireEvent.change(input, { target: { value: 'Lou' } })
    expect(autocomplete).not.toHaveBeenCalled()
    expect(await screen.findByText('Louvre')).toBeInTheDocument()
    expect(screen.getByText('Paris, France')).toBeInTheDocument()
    // autocomplete(input, language, locationBias, signal, session)
    expect(autocomplete.mock.calls[0][0]).toBe('Lou')
    expect(autocomplete.mock.calls[0][1]).toBe('en')
  })

  it('FE-MOB-PLSRCH-003: forwards the trip-centre bias', async () => {
    const autocomplete = mockAutocomplete()
    const bias = { low: { lat: 48.8, lng: 2.3 }, high: { lat: 48.9, lng: 2.4 } }
    const { input } = setup({}, bias)
    fireEvent.change(input, { target: { value: 'Lou' } })
    await waitFor(() => expect(autocomplete).toHaveBeenCalled())
    expect(autocomplete.mock.calls[0][2]).toEqual(bias)
  })

  it('FE-MOB-PLSRCH-004: picking a suggestion applies its resolved details and clears the field', async () => {
    mockAutocomplete()
    vi.spyOn(mapsApi, 'details').mockResolvedValue({ place: LOUVRE })
    const { input, onPick } = setup()
    fireEvent.change(input, { target: { value: 'Lou' } })
    const row = await screen.findByText('Louvre')
    // The row swallows pointerdown so the field's blur handler cannot close
    // the dropdown before the click lands.
    const pointerDown = fireEvent.pointerDown(row)
    expect(pointerDown).toBe(false)
    fireEvent.click(row)

    // Optimistic name first, then the full record.
    expect(onPick).toHaveBeenNthCalledWith(1, { name: 'Louvre' })
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(2))
    expect(onPick).toHaveBeenLastCalledWith({
      name: 'Louvre Museum',
      address: 'Rue de Rivoli, Paris',
      lat: '48.8606',
      lng: '2.3376',
      google_place_id: 'ChIJ_louvre',
      google_ftid: '0x47e:0x1',
      osm_id: 'W7444,',
      website: 'https://louvre.fr',
      phone: '+33 1',
    })
    expect(input).toHaveValue('')
  })

  it('FE-MOB-PLSRCH-005: falls back to the text search when the details hop fails', async () => {
    mockAutocomplete()
    vi.spyOn(mapsApi, 'details').mockRejectedValue(new LocalApiError(500, 'disabled'))
    const search = mockSearch()
    const { input, onPick } = setup()
    fireEvent.change(input, { target: { value: 'Lou' } })
    fireEvent.click(await screen.findByText('Louvre'))

    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(2))
    // The fallback searches for the suggestion's two lines joined.
    expect(search.mock.calls[0][0]).toBe('Louvre, Paris, France')
    expect(onPick).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Louvre Museum', lat: '48.8606' }))
  })

  it('FE-MOB-PLSRCH-005b: an OpenStreetMap row keeps its own coordinates instead of searching for its label', async () => {
    // The layer's second line is the name written on the building, not an
    // address, so joining the two asks a question nobody typed — and whatever
    // came back first was taken as the place the user had already picked.
    mockAutocomplete([{
      placeId: 'node:9712313',
      mainText: 'Tokio Hauptbahnhof',
      secondaryText: '東京駅丸の内駅舎',
      source: 'openstreetmap',
      lat: 35.6811816,
      lng: 139.76598265,
    }])
    vi.spyOn(mapsApi, 'details').mockResolvedValue({ place: null, disabled: true })
    const search = mockSearch()
    const { input, onPick } = setup()
    fireEvent.change(input, { target: { value: 'Tok' } })
    fireEvent.click(await screen.findByText('Tokio Hauptbahnhof'))

    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(2))
    expect(search).not.toHaveBeenCalled()
    expect(onPick).toHaveBeenLastCalledWith(expect.objectContaining({
      name: 'Tokio Hauptbahnhof', lat: '35.6811816', lng: '139.76598265',
    }))
  })

  it('FE-MOB-PLSRCH-005c: a suggestion says which index answered', async () => {
    // Both indexes answer the keystroke path at once, so the name the response
    // carries for the whole list is true of the call and wrong for half its rows.
    mockAutocomplete([
      { ...SUGGESTION, source: 'trek-places' },
      { placeId: 'node:1', mainText: 'Louvre Palace', secondaryText: 'Palais du Louvre', source: 'openstreetmap' },
    ])
    const { input } = setup()
    fireEvent.change(input, { target: { value: 'Lou' } })

    expect(await screen.findByText('TREK')).toBeInTheDocument()
    expect(await screen.findByText('OpenStreetMap')).toBeInTheDocument()
  })

  it('FE-MOB-PLSRCH-006: also falls back when the details hop answers without coordinates', async () => {
    mockAutocomplete()
    vi.spyOn(mapsApi, 'details').mockResolvedValue({ place: { name: 'Louvre' } })
    const search = mockSearch()
    const { input, onPick } = setup()
    fireEvent.change(input, { target: { value: 'Lou' } })
    fireEvent.click(await screen.findByText('Louvre'))

    await waitFor(() => expect(search).toHaveBeenCalledTimes(1))
    expect(onPick).toHaveBeenLastCalledWith(expect.objectContaining({ lat: '48.8606' }))
  })

  it('FE-MOB-PLSRCH-007: restores the typed query and toasts when nothing resolves', async () => {
    mockAutocomplete()
    vi.spyOn(mapsApi, 'details').mockRejectedValue(new LocalApiError(500, 'boom'))
    mockSearch([])
    const { input, planner } = setup()
    fireEvent.change(input, { target: { value: 'Lou' } })
    fireEvent.click(await screen.findByText('Louvre'))

    await waitFor(() => expect(planner.toast.error).toHaveBeenCalledWith('places.mapsSearchError'))
    expect(input).toHaveValue('Lou')
  })

  it('FE-MOB-PLSRCH-008: surfaces the server message when the fallback search rejects', async () => {
    mockAutocomplete()
    vi.spyOn(mapsApi, 'details').mockRejectedValue(new LocalApiError(500, 'boom'))
    vi.spyOn(mapsApi, 'search').mockRejectedValue(new LocalApiError(502, 'Places API is disabled'))
    const { input, planner } = setup()
    fireEvent.change(input, { target: { value: 'Lou' } })
    fireEvent.click(await screen.findByText('Louvre'))

    await waitFor(() => expect(planner.toast.error).toHaveBeenCalledWith('Places API is disabled'))
    expect(input).toHaveValue('Lou')
  })

  it('FE-MOB-PLSRCH-009: a "lat, lng" query becomes coordinates without any lookup', async () => {
    const autocomplete = mockAutocomplete()
    const search = mockSearch()
    const { input, onPick } = setup()
    fireEvent.change(input, { target: { value: '48.8566; 2.3522' } })
    fireEvent.click(screen.getByRole('button', { name: 'common.search' }))

    expect(onPick).toHaveBeenCalledWith({ lat: '48.8566', lng: '2.3522' })
    expect(input).toHaveValue('')
    await new Promise(r => setTimeout(r, 400))
    expect(autocomplete).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
  })

  it('FE-MOB-PLSRCH-010: resolves a Google Maps URL and confirms it', async () => {
    mockAutocomplete()
    vi.spyOn(mapsApi, 'resolveUrl').mockResolvedValue({
      lat: 48.86, lng: 2.33, name: 'Louvre', address: 'Paris', google_ftid: '0x1:0x2',
    })
    const { input, onPick, planner } = setup()
    fireEvent.change(input, { target: { value: 'https://maps.app.goo.gl/abc' } })
    fireEvent.click(screen.getByRole('button', { name: 'common.search' }))

    await waitFor(() => expect(planner.toast.success).toHaveBeenCalledWith('places.urlResolved'))
    expect(onPick).toHaveBeenCalledWith({
      name: 'Louvre', address: 'Paris', lat: '48.86', lng: '2.33', google_ftid: '0x1:0x2',
    })
    expect(input).toHaveValue('')
    // URLs never hit the autocomplete debounce.
    expect(vi.mocked(mapsApi.autocomplete)).not.toHaveBeenCalled()
  })

  it('FE-MOB-PLSRCH-011: falls through to the text search when the URL carries no coordinates', async () => {
    // resolveUrl answers 400 on a link with no usable coordinates, so the
    // `resolved.lat && resolved.lng` guard only ever sees the 0,0 edge now.
    vi.spyOn(mapsApi, 'resolveUrl').mockResolvedValue({ lat: 0, lng: 0, name: null, address: null })
    const search = mockSearch()
    const { input, planner } = setup()
    fireEvent.change(input, { target: { value: 'https://www.google.com/maps/place/Louvre' } })
    fireEvent.click(screen.getByRole('button', { name: 'common.search' }))

    await waitFor(() => expect(search).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Louvre Museum')).toBeInTheDocument()
    expect(planner.toast.success).not.toHaveBeenCalled()
  })

  it('FE-MOB-PLSRCH-012: lists text results and applies the tapped one', async () => {
    mockSearch([LOUVRE, { name: 'Louvre Lens', address: 'Lens' }])
    const { input, onPick } = setup()
    fireEvent.change(input, { target: { value: 'louvre museum' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText('Louvre Museum')).toBeInTheDocument()
    expect(screen.getByText('Louvre Lens')).toBeInTheDocument()
    expect(screen.getByText('Rue de Rivoli, Paris')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Louvre Lens'))
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ name: 'Louvre Lens', address: 'Lens', lat: undefined }))
    await waitFor(() => expect(screen.queryByText('Louvre Museum')).not.toBeInTheDocument())
    expect(input).toHaveValue('')
  })

  it('FE-MOB-PLSRCH-013: an empty query does nothing', async () => {
    const search = mockSearch()
    const { onPick } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'common.search' }))
    await new Promise(r => setTimeout(r, 50))
    expect(search).not.toHaveBeenCalled()
    expect(onPick).not.toHaveBeenCalled()
  })

  it('FE-MOB-PLSRCH-014: reports the resolving state and blocks the button while searching', async () => {
    vi.mocked(mapsApi.search).mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 120))
      return { places: [LOUVRE] as never, source: 'osm' }
    })
    const { input, onResolvingChange } = setup()
    fireEvent.change(input, { target: { value: 'louvre museum' } })
    fireEvent.click(screen.getByRole('button', { name: 'common.search' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'common.search' })).toBeDisabled())
    expect(onResolvingChange).toHaveBeenCalledWith(true)
    await waitFor(() => expect(onResolvingChange).toHaveBeenLastCalledWith(false))
    expect(screen.getByRole('button', { name: 'common.search' })).not.toBeDisabled()
  })

  it('FE-MOB-PLSRCH-015: toasts the fallback message when the search fails without a body', async () => {
    // A bare rejection carries no `response.data.error`, so the toast falls
    // back to the generic search-failed key.
    vi.spyOn(mapsApi, 'search').mockRejectedValue(new Error('network down'))
    const { input, planner } = setup()
    fireEvent.change(input, { target: { value: 'louvre museum' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(planner.toast.error).toHaveBeenCalledWith('places.mapsSearchError'))
  })

  it('FE-MOB-PLSRCH-016: a failing autocomplete empties the dropdown', async () => {
    const autocomplete = mockAutocomplete()
    const { input } = setup()
    fireEvent.change(input, { target: { value: 'Lou' } })
    expect(await screen.findByText('Louvre')).toBeInTheDocument()

    autocomplete.mockRejectedValue(new LocalApiError(500, 'boom'))
    fireEvent.change(input, { target: { value: 'Louv' } })
    await waitFor(() => expect(screen.queryByText('Louvre')).not.toBeInTheDocument())
  })

  it('FE-MOB-PLSRCH-017: a superseded autocomplete is aborted and does not clear the newer list', async () => {
    const calls: string[] = []
    vi.mocked(mapsApi.autocomplete).mockImplementation(async (input, _lang, _bias, signal) => {
      calls.push(input)
      if (input === 'Lou') {
        // In flight until the next keystroke aborts it — the real adapter
        // rejects with AbortError at that point.
        await new Promise<never>((_, rej) => {
          if (signal?.aborted) rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        })
      }
      return { suggestions: [SUGGESTION] as never, source: 'osm' }
    })
    const { input } = setup()
    fireEvent.change(input, { target: { value: 'Lou' } })
    await waitFor(() => expect(calls).toHaveLength(1))
    fireEvent.change(input, { target: { value: 'Louvre mus' } })

    expect(await screen.findByText('Louvre')).toBeInTheDocument()
    await new Promise(r => setTimeout(r, 100))
    expect(screen.getByText('Louvre')).toBeInTheDocument()
  })

  it('FE-MOB-PLSRCH-018b: a suggestion without a second line searches on its main text alone', async () => {
    mockAutocomplete([{ placeId: 'sug-2', mainText: 'Louvre', secondaryText: '' }])
    vi.spyOn(mapsApi, 'details').mockRejectedValue(new LocalApiError(500, 'boom'))
    const search = mockSearch()
    const { input } = setup()
    fireEvent.change(input, { target: { value: 'Lou' } })
    fireEvent.click(await screen.findByText('Louvre'))
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1))
    expect(search.mock.calls[0][0]).toBe('Louvre')
  })

  it('FE-MOB-PLSRCH-018c: a response without a places array leaves the result list empty', async () => {
    vi.mocked(mapsApi.search).mockResolvedValue({ source: 'osm' } as never)
    const { input, planner } = setup()
    fireEvent.change(input, { target: { value: 'louvre museum' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'common.search' })).not.toBeDisabled())
    expect(screen.queryByText('Louvre Museum')).not.toBeInTheDocument()
    expect(planner.toast.error).not.toHaveBeenCalled()
  })

  it('FE-MOB-PLSRCH-018d: a nameless result still renders and can be picked', async () => {
    const search = mockSearch([{ lat: 48.86, lng: 2.33 }])
    const { input, onPick } = setup()
    fireEvent.change(input, { target: { value: 'louvre museum' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(search).toHaveBeenCalledTimes(1))
    // The only unlabelled button is the result row; its two lines stay empty.
    const rows = (await screen.findAllByRole('button')).filter(b => !b.getAttribute('aria-label'))
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toBe('')
    fireEvent.click(rows[0])
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ name: undefined, lat: '48.86', lng: '2.33' }))
  })

  it('FE-MOB-PLSRCH-018e: keys other than Enter do not trigger a search', async () => {
    const search = mockSearch()
    const { input } = setup()
    fireEvent.change(input, { target: { value: 'louvre museum' } })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    await new Promise(r => setTimeout(r, 50))
    expect(search).not.toHaveBeenCalled()
  })

  it('FE-MOB-PLSRCH-018f: a URL that resolves to bare coordinates picks them without extras', async () => {
    vi.spyOn(mapsApi, 'resolveUrl').mockResolvedValue({
      lat: 48.86, lng: 2.33, name: null, address: null, google_ftid: null,
    })
    const { input, onPick, planner } = setup()
    fireEvent.change(input, { target: { value: 'https://goo.gl/maps/xyz' } })
    fireEvent.click(screen.getByRole('button', { name: 'common.search' }))

    await waitFor(() => expect(planner.toast.success).toHaveBeenCalledWith('places.urlResolved'))
    expect(onPick).toHaveBeenCalledWith({
      name: undefined, address: undefined, lat: '48.86', lng: '2.33', google_ftid: undefined,
    })
  })

  it('FE-MOB-PLSRCH-018: blurring the field dismisses the dropdown', async () => {
    mockAutocomplete()
    const { input } = setup()
    fireEvent.change(input, { target: { value: 'Lou' } })
    expect(await screen.findByText('Louvre')).toBeInTheDocument()
    fireEvent.blur(input)
    await waitFor(() => expect(screen.queryByText('Louvre')).not.toBeInTheDocument())
  })


  it('FE-MOB-PLSRCH-020: without a Google key the list offers nothing', async () => {
    mockGoogleRetry()
    const { input } = setup()
    fireEvent.change(input, { target: { value: 'Tokyo Station' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('Weigh station')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'places.searchGoogleInstead' })).not.toBeInTheDocument()
  })

  it('FE-MOB-PLSRCH-021: a key alone is not enough: with Amap or OpenStreetMap picked the list offers nothing', async () => {
    // The server only honours the request while Google holds the keyed slot;
    // under another provider the line would re-run the same search and stay.
    seedStore(useAuthStore, { hasMapsKey: true, placesProvider: 'amap' })
    mockGoogleRetry()
    const { input } = setup()
    fireEvent.change(input, { target: { value: 'Tokyo Station' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('Weigh station')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'places.searchGoogleInstead' })).not.toBeInTheDocument()
  })


})
