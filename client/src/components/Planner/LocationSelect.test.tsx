// FE-PLANNER-LOCSEL-001 to FE-PLANNER-LOCSEL-019
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, fireEvent, waitFor, act } from '../../../tests/helpers/render';
import { mapsApi } from '../../api/client';
import LocationSelect, { type LocationPoint } from './LocationSelect';

interface SearchHit {
  name?: string;
  address?: string | null;
  lat?: number | string;
  lng?: number | string;
  osm_id?: string;
  google_place_id?: string;
}

const GARE = { name: 'Gare du Nord', address: '18 Rue de Dunkerque, Paris', lat: 48.8809, lng: 2.3553, osm_id: 'n1' };
const LYON = { name: 'Gare de Lyon', address: 'Place Louis-Armand, Paris', lat: 48.8443, lng: 2.3738, osm_id: 'n2' };

/** Let the debounce fire and any in-flight request settle. */
async function settle(ms = 450) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

/**
 * mapsApi is the local facade over the browser-side provider clients now —
 * there is no /api/maps route to intercept, so the search is stubbed at the
 * module boundary with the envelope the component reads (`{ places }`).
 */
function mockSearch(places: SearchHit[] | ((query: string) => Promise<{ places: SearchHit[] }>)) {
  const spy = vi.spyOn(mapsApi, 'search');
  if (typeof places === 'function') {
    spy.mockImplementation(places as typeof mapsApi.search);
  } else {
    spy.mockResolvedValue({ places: places as unknown as Record<string, unknown>[], source: 'openstreetmap' });
  }
  return spy;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// Controlled host — `value` drives the input text and mutes the search for the
// already-picked name, exactly like ReservationModal wires it up.
function Host({ initial = null, onPick }: { initial?: LocationPoint | null; onPick?: (l: LocationPoint | null) => void }) {
  const [value, setValue] = useState<LocationPoint | null>(initial);
  return <LocationSelect value={value} onChange={(l) => { setValue(l); onPick?.(l); }} />;
}

describe('LocationSelect', () => {
  it('FE-PLANNER-LOCSEL-001: falls back to the translated placeholder', () => {
    render(<LocationSelect value={null} onChange={vi.fn()} />);
    expect(screen.getByPlaceholderText('Search station, port, address…')).toBeInTheDocument();
  });

  it('FE-PLANNER-LOCSEL-002: an explicit placeholder wins over the default', () => {
    render(<LocationSelect value={null} onChange={vi.fn()} placeholder="Pick-up point" />);
    expect(screen.getByPlaceholderText('Pick-up point')).toBeInTheDocument();
  });

  it('FE-PLANNER-LOCSEL-003: an initial value renders its name plus a clear button', () => {
    render(<LocationSelect value={{ name: 'Gare du Nord', lat: 48.88, lng: 2.35 }} onChange={vi.fn()} />);
    expect(screen.getByDisplayValue('Gare du Nord')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
  });

  it('FE-PLANNER-LOCSEL-004: no clear button without a value', () => {
    render(<LocationSelect value={null} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  });

  it('FE-PLANNER-LOCSEL-005: fewer than three characters never reach the API', async () => {
    const user = userEvent.setup();
    const search = mockSearch([GARE]);

    render(<Host />);
    await user.type(screen.getByRole('textbox'), 'Ga');

    await settle();
    expect(search).not.toHaveBeenCalled();
    expect(screen.queryByText('Gare du Nord')).not.toBeInTheDocument();
  });

  it('FE-PLANNER-LOCSEL-006: three characters open the dropdown with name and address', async () => {
    const user = userEvent.setup();
    mockSearch([GARE]);

    render(<Host />);
    await user.type(screen.getByRole('textbox'), 'Gare');

    expect(await screen.findByText('Gare du Nord')).toBeInTheDocument();
    expect(screen.getByText('18 Rue de Dunkerque, Paris')).toBeInTheDocument();
  });

  it('FE-PLANNER-LOCSEL-007: the query and locale are forwarded to the maps API', async () => {
    const user = userEvent.setup();
    const search = mockSearch([GARE]);

    render(<Host />);
    await user.type(screen.getByRole('textbox'), '  Gare du Nord  ');
    await screen.findByText('Gare du Nord');

    // mapsApi.search(query, locale, locationBias)
    expect(search.mock.calls[0]?.[0]).toBe('Gare du Nord');
    expect(search.mock.calls[0]?.[1]).toBe('en-US');
  });

  it('FE-PLANNER-LOCSEL-008: a hit whose address equals its name shows no duplicate subtitle', async () => {
    const user = userEvent.setup();
    mockSearch([{ name: 'Rue de Rivoli', address: 'Rue de Rivoli', lat: 48.85, lng: 2.35, osm_id: 'n9' }]);

    render(<Host />);
    await user.type(screen.getByRole('textbox'), 'Rivoli');

    expect(await screen.findAllByText('Rue de Rivoli')).toHaveLength(1);
  });

  it('FE-PLANNER-LOCSEL-009: a nameless hit is labelled by its address', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    mockSearch([{ address: '12 Rue Oberkampf', lat: 48.86, lng: 2.37, google_place_id: 'g1' }]);

    render(<Host onPick={onPick} />);
    await user.type(screen.getByRole('textbox'), 'Oberkampf');

    // The row falls back to the address for its title and skips the address
    // subtitle, so the text shows up once.
    const rows = await screen.findAllByText('12 Rue Oberkampf');
    expect(rows).toHaveLength(1);

    await user.click(rows[0]);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ name: '12 Rue Oberkampf' }));
  });

  it('FE-PLANNER-LOCSEL-010: shows the loading row while the request is in flight', async () => {
    const user = userEvent.setup();
    mockSearch(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { places: [GARE] };
    });

    render(<Host />);
    await user.type(screen.getByRole('textbox'), 'Gare');

    expect(await screen.findByText('Loading...')).toBeInTheDocument();
    expect(await screen.findByText('Gare du Nord')).toBeInTheDocument();
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
  });

  it('FE-PLANNER-LOCSEL-011: picking a hit reports name, coordinates and address', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    mockSearch([GARE]);

    render(<Host onPick={onPick} />);
    await user.type(screen.getByRole('textbox'), 'Gare');
    await user.click(await screen.findByText('Gare du Nord'));

    expect(onPick).toHaveBeenCalledWith({
      name: 'Gare du Nord',
      lat: 48.8809,
      lng: 2.3553,
      address: '18 Rue de Dunkerque, Paris',
    });
    expect(screen.queryByText('18 Rue de Dunkerque, Paris')).not.toBeInTheDocument();
  });

  it('FE-PLANNER-LOCSEL-012: string coordinates are coerced to numbers', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    mockSearch([{ name: 'Porto Cruise Terminal', address: null, lat: '41.1496', lng: '-8.6109', osm_id: 'n3' }]);

    render(<Host onPick={onPick} />);
    await user.type(screen.getByRole('textbox'), 'Porto');
    await user.click(await screen.findByText('Porto Cruise Terminal'));

    expect(onPick).toHaveBeenCalledWith({ name: 'Porto Cruise Terminal', lat: 41.1496, lng: -8.6109, address: null });
  });

  it('FE-PLANNER-LOCSEL-013: a hit without usable coordinates is ignored', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    mockSearch([{ name: 'Broken Hit', address: 'nowhere', lat: 'abc', lng: '2.35', osm_id: 'n4' }]);

    render(<Host onPick={onPick} />);
    await user.type(screen.getByRole('textbox'), 'Broken');
    await user.click(await screen.findByText('Broken Hit'));

    expect(onPick).not.toHaveBeenCalled();
    // The dropdown stays open so the user can try another row.
    expect(screen.getByText('Broken Hit')).toBeInTheDocument();
  });

  it('FE-PLANNER-LOCSEL-014: the clear button resets value and text', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();

    render(<Host initial={{ name: 'Gare du Nord', lat: 48.88, lng: 2.35, address: null }} onPick={onPick} />);
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(onPick).toHaveBeenCalledWith(null);
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('FE-PLANNER-LOCSEL-015: typing over a picked location drops the selection', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    mockSearch([]);

    render(<Host initial={{ name: 'Gare du Nord', lat: 48.88, lng: 2.35 }} onPick={onPick} />);
    await user.type(screen.getByRole('textbox'), 'X');

    expect(onPick).toHaveBeenCalledWith(null);
  });

  it('FE-PLANNER-LOCSEL-016: ArrowDown/ArrowUp move the highlight and Enter picks it', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    mockSearch([GARE, LYON]);

    render(<Host onPick={onPick} />);
    await user.type(screen.getByRole('textbox'), 'Gare');
    await screen.findByText('Gare du Nord');

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}{Enter}');

    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ name: 'Gare du Nord' }));
  });

  it('FE-PLANNER-LOCSEL-017: Escape closes the dropdown and keeps the typed text', async () => {
    const user = userEvent.setup();
    mockSearch([GARE]);

    render(<Host />);
    const input = screen.getByRole('textbox');
    await user.type(input, 'Gare');
    await screen.findByText('Gare du Nord');

    await user.keyboard('{Escape}');

    expect(screen.queryByText('Gare du Nord')).not.toBeInTheDocument();
    expect(input).toHaveValue('Gare');
  });

  it('FE-PLANNER-LOCSEL-018: a mousedown outside the field closes the dropdown', async () => {
    const user = userEvent.setup();
    mockSearch([GARE]);

    render(<Host />);
    await user.type(screen.getByRole('textbox'), 'Gare');
    await screen.findByText('Gare du Nord');

    fireEvent.mouseDown(document.body);

    await waitFor(() => expect(screen.queryByText('Gare du Nord')).not.toBeInTheDocument());
  });

  it('FE-PLANNER-LOCSEL-019: a failing search drops the previous suggestions', async () => {
    const user = userEvent.setup();
    mockSearch(async (query) => {
      if (query === 'Gare') return { places: [GARE] };
      throw new Error('Places API is disabled');
    });

    render(<Host />);
    const input = screen.getByRole('textbox');
    await user.type(input, 'Gare');
    await screen.findByText('Gare du Nord');

    await user.type(input, 's');

    await waitFor(() => expect(screen.queryByText('Gare du Nord')).not.toBeInTheDocument());
  });
});
