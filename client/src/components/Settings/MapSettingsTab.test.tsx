// FE-COMP-MAP-001 to FE-COMP-MAP-035
import { render, screen, waitFor, within } from '../../../tests/helpers/render';
import userEvent from '@testing-library/user-event';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildUser, buildSettings } from '../../../tests/helpers/factories';
import { ToastContainer } from '../shared/Toast';
import MapSettingsTab from './MapSettingsTab';

// Mock MapView to avoid Leaflet DOM issues in jsdom. tileUrl is surfaced because
// the preview has to draw the basemap being configured, key included.
vi.mock('../Map/MapView', () => ({
  MapView: ({ onMapClick, tileUrl }: { onMapClick?: (info: { latlng: { lat: number; lng: number } }) => void; tileUrl?: string }) => (
    <div data-testid="map-view" data-tile-url={tileUrl} onClick={() => onMapClick?.({ latlng: { lat: 51.5, lng: -0.1 } })} />
  ),
}));

beforeEach(() => {
  resetAllStores();
  vi.clearAllMocks();
  seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true });
  seedStore(useSettingsStore, {
    settings: buildSettings({ map_tile_url: '' }),
    updateSettings: vi.fn().mockResolvedValue(undefined),
  });
});

describe('MapSettingsTab', () => {
  it('FE-COMP-MAP-001: renders without crashing', () => {
    render(<MapSettingsTab />);
    expect(document.body).toBeInTheDocument();
  });

  it('FE-COMP-MAP-002: shows the Map section title', () => {
    render(<MapSettingsTab />);
    expect(screen.getByText('Map')).toBeInTheDocument();
  });

  it('FE-COMP-MAP-003: shows the map template label', () => {
    render(<MapSettingsTab />);
    expect(screen.getByText('Map Template')).toBeInTheDocument();
  });

  it('FE-COMP-MAP-004: no longer offers a default map centre — each map frames its own places', () => {
    render(<MapSettingsTab />);
    expect(screen.queryByText('Latitude')).not.toBeInTheDocument();
    expect(screen.queryByText('Longitude')).not.toBeInTheDocument();
  });

  it('FE-COMP-MAP-005: PanelMint is Leaflet-only — no provider picker remains', () => {
    render(<MapSettingsTab />);
    expect(screen.queryByText('Mapbox GL')).not.toBeInTheDocument();
    expect(screen.queryByText('MapLibre GL')).not.toBeInTheDocument();
    expect(screen.getByTestId('map-view')).toBeInTheDocument();
  });

  it('FE-COMP-MAP-009: tile URL text input is shown', () => {
    render(<MapSettingsTab />);
    const tileInput = screen.getByPlaceholderText(/openstreetmap/i);
    expect(tileInput).toBeInTheDocument();
  });

  it('FE-COMP-MAP-010: typing a custom tile URL updates the text input', async () => {
    const user = userEvent.setup();
    render(<MapSettingsTab />);
    const tileInput = screen.getByPlaceholderText(/openstreetmap/i);
    await user.clear(tileInput);
    // Escape curly braces so userEvent doesn't treat them as special keys
    await user.type(tileInput, 'https://custom.tiles/{{z}/{{x}/{{y}.png');
    expect(screen.getByDisplayValue('https://custom.tiles/{z}/{x}/{y}.png')).toBeInTheDocument();
  });

  it('FE-COMP-MAP-011: clicking the Save Map button calls updateSettings', async () => {
    const user = userEvent.setup();
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    seedStore(useSettingsStore, {
      settings: buildSettings({ map_tile_url: '' }),
      updateSettings,
    });
    render(<MapSettingsTab />);
    await user.click(screen.getByText('Save Map'));
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      map_tile_url: expect.any(String),
    }));
  });

  it('FE-COMP-MAP-012: Save Map no longer writes a default centre or zoom', async () => {
    const user = userEvent.setup();
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    seedStore(useSettingsStore, {
      settings: buildSettings({ map_tile_url: '' }),
      updateSettings,
    });
    render(<MapSettingsTab />);
    await user.click(screen.getByText('Save Map'));

    const saved = updateSettings.mock.calls[0][0];
    expect(saved).not.toHaveProperty('default_lat');
    expect(saved).not.toHaveProperty('default_lng');
    expect(saved).not.toHaveProperty('default_zoom');
  });

  it('FE-COMP-MAP-013: Save Map button shows spinner while saving', async () => {
    const user = userEvent.setup();
    const updateSettings = vi.fn().mockReturnValue(new Promise(() => {}));
    seedStore(useSettingsStore, {
      settings: buildSettings(),
      updateSettings,
    });
    render(<MapSettingsTab />);
    await user.click(screen.getByText('Save Map'));
    const saveBtn = screen.getByText('Save Map').closest('button')!;
    expect(saveBtn).toBeDisabled();
  });

  it('FE-COMP-MAP-014: Save Map error shows a toast', async () => {
    const user = userEvent.setup();
    const updateSettings = vi.fn().mockRejectedValue(new Error('Save failed'));
    seedStore(useSettingsStore, {
      settings: buildSettings(),
      updateSettings,
    });
    render(<><ToastContainer /><MapSettingsTab /></>);
    await user.click(screen.getByText('Save Map'));
    expect(await screen.findByText('Save failed')).toBeInTheDocument();
  });

  it('FE-COMP-MAP-016: preset dropdown is rendered', () => {
    render(<MapSettingsTab />);
    expect(screen.getByText('Select template...')).toBeInTheDocument();
  });

  it('FE-COMP-MAP-017: settings update from store syncs local state', async () => {
    const { rerender } = render(<MapSettingsTab />);

    seedStore(useSettingsStore, {
      settings: buildSettings({ map_tile_url: 'https://custom.tiles/{z}/{x}/{y}.png' }),
    });
    rerender(<MapSettingsTab />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://custom.tiles/{z}/{x}/{y}.png')).toBeInTheDocument();
    });
  });

  it('FE-COMP-MAP-030: picking a Leaflet template fills the tile URL input', async () => {
    const user = userEvent.setup();
    render(<MapSettingsTab />);

    await user.click(screen.getByText('Select template...'));
    await user.click(await screen.findByText('CartoDB Dark'));

    expect(screen.getByDisplayValue('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png')).toBeInTheDocument();
  });
});

// ── CARTO key (031–035) ─────────────────────────────────────────────

const CARTO_DARK_TILES = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';

/** The key input sits under its label inside the field's own wrapper. */
function cartoInput(): HTMLInputElement {
  return within(screen.getByText('CARTO API key').closest('div') as HTMLElement).getByRole('textbox');
}

describe('MapSettingsTab – CARTO key', () => {
  it('FE-COMP-MAP-031: the key field is offered alongside the raster basemap fields', () => {
    render(<MapSettingsTab />);

    expect(screen.getByText('CARTO API key')).toBeInTheDocument();
  });

  it('FE-COMP-MAP-032: a managed instance brings its own key, so the field is hidden', () => {
    seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true, managed: true });
    render(<MapSettingsTab />);

    expect(screen.queryByText('CARTO API key')).not.toBeInTheDocument();
  });

  it('FE-COMP-MAP-033: the typed key is part of the save patch', async () => {
    const user = userEvent.setup();
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    seedStore(useSettingsStore, {
      settings: buildSettings({ map_tile_url: CARTO_DARK_TILES }),
      updateSettings,
    });
    render(<MapSettingsTab />);

    await user.type(cartoInput(), 'demo-key');
    await user.click(screen.getByText('Save Map'));

    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ carto_api_key: 'demo-key' }));
  });

  it('FE-COMP-MAP-033b: the preview draws the CARTO basemap being configured, not the app default', async () => {
    // The fields hold what the user is editing, not what useTileUrl resolved, so
    // the key has to be put back on before the preview reads the template.
    // Without it the preview resolves a keyless CARTO url, silently falls back to
    // the default vector style, and shows a basemap nobody chose.
    const user = userEvent.setup();
    seedStore(useSettingsStore, {
      settings: buildSettings({ map_tile_url: CARTO_DARK_TILES, carto_api_key: 'demo-key' }),
    });
    render(<MapSettingsTab />);

    await waitFor(() => {
      expect(screen.getByTestId('map-view').getAttribute('data-tile-url')).toContain('key=demo-key');
    });

    await user.clear(cartoInput());
    await waitFor(() => {
      expect(screen.getByTestId('map-view').getAttribute('data-tile-url')).not.toContain('key=');
    });
  });

  it('FE-COMP-MAP-034: a CARTO template without a key explains the watermark until one is typed', async () => {
    const user = userEvent.setup();
    seedStore(useSettingsStore, {
      settings: buildSettings({ map_tile_url: CARTO_DARK_TILES }),
      updateSettings: vi.fn().mockResolvedValue(undefined),
    });
    render(<MapSettingsTab />);

    expect(screen.getByText(/API KEY REQUIRED/)).toBeInTheDocument();

    await user.type(cartoInput(), 'demo-key');

    expect(screen.queryByText(/API KEY REQUIRED/)).not.toBeInTheDocument();
  });

  it('FE-COMP-MAP-035: a template on another host never gets that notice', () => {
    seedStore(useSettingsStore, {
      settings: buildSettings({ map_tile_url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' }),
      updateSettings: vi.fn().mockResolvedValue(undefined),
    });
    render(<MapSettingsTab />);

    expect(screen.queryByText(/API KEY REQUIRED/)).not.toBeInTheDocument();
  });
});
