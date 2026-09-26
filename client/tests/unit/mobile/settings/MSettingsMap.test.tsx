// FE-MOB-SETMAP-001 onwards
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '../../../helpers/render';
import { resetAllStores, seedStore } from '../../../helpers/store';
import { buildSettings } from '../../../helpers/factories';
import { useSettingsStore } from '../../../../src/store/settingsStore';
import { ToastContainer } from '../../../../src/components/shared/Toast';
import type { Settings } from '../../../../src/types';
import MSettingsMap from '../../../../src/mobile/screens/settings/MSettingsMap';

// Leaflet needs a real canvas — stub it and expose the props the screen feeds it
// so the preview wiring stays assertable.
vi.mock('../../../../src/components/Map/MapView', () => ({
  MapView: ({ tileUrl }: { tileUrl: string }) => <div data-testid="leaflet-preview" data-tile={tileUrl} />,
}));

const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const CARTO_DARK_TILES = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';

function seedMap(over: Partial<Settings> = {}, updateSettings = vi.fn().mockResolvedValue(undefined)) {
  seedStore(useSettingsStore, {
    settings: buildSettings({ language: 'en', map_tile_url: '', ...over }),
    updateSettings,
  });
  return updateSettings;
}

/** The CARTO key input follows its eyebrow label in the card's flat layout. */
function cartoInput(): HTMLInputElement {
  return screen.getByText('CARTO API key').nextElementSibling as HTMLInputElement;
}

function renderMap() {
  return render(
    <>
      <ToastContainer />
      <MSettingsMap />
    </>,
  );
}

describe('MSettingsMap', () => {
  beforeEach(() => {
    resetAllStores();
    seedMap();
  });

  it('FE-MOB-SETMAP-001: PanelMint is Leaflet-only — template fields and preview, no provider picker', () => {
    renderMap();

    expect(screen.queryByText('Mapbox GL')).not.toBeInTheDocument();
    expect(screen.queryByText('MapLibre GL')).not.toBeInTheDocument();
    expect(screen.getByTestId('leaflet-preview')).toBeInTheDocument();
  });

  it('FE-MOB-SETMAP-002: shows the tile template row and the raw URL input', () => {
    seedMap({ map_tile_url: OSM_URL });
    renderMap();

    expect(screen.getByText('OpenStreetMap')).toBeInTheDocument();
    expect(screen.getByDisplayValue(OSM_URL)).toBeInTheDocument();
    expect(screen.getByTestId('leaflet-preview')).toHaveAttribute('data-tile', OSM_URL);
  });

  it('FE-MOB-SETMAP-003: an unknown tile URL falls back to the select placeholder', () => {
    seedMap({ map_tile_url: 'https://custom.tiles/{z}/{x}/{y}.png' });
    renderMap();

    expect(screen.getByText('Select template...')).toBeInTheDocument();
  });

  it('FE-MOB-SETMAP-004: the template sheet writes the chosen preset into the URL field', async () => {
    const user = userEvent.setup();
    renderMap();

    await user.click(screen.getByRole('button', { name: /Select template/ }));
    await user.click(await screen.findByRole('button', { name: 'CartoDB Dark' }));

    expect(screen.getByDisplayValue('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png')).toBeInTheDocument();
  });

  it('FE-MOB-SETMAP-005: typing a tile URL feeds straight into the Leaflet preview', async () => {
    const user = userEvent.setup();
    renderMap();

    await user.type(screen.getByPlaceholderText(OSM_URL), 'https://tiles.test/a.png');
    expect(screen.getByTestId('leaflet-preview')).toHaveAttribute('data-tile', 'https://tiles.test/a.png');
  });

  it('FE-MOB-SETMAP-012: saving persists the tile URL and the CARTO key', async () => {
    const user = userEvent.setup();
    const updateSettings = seedMap({ map_tile_url: OSM_URL });
    renderMap();

    await user.click(screen.getByRole('button', { name: 'Save Map' }));

    expect(updateSettings).toHaveBeenCalledWith({
      map_tile_url: OSM_URL,
      carto_api_key: '',
    });
    await screen.findByText('Map settings saved');
  });

  it('FE-MOB-SETMAP-015: the save button is disabled while the write is in flight', async () => {
    const user = userEvent.setup();
    seedMap({}, vi.fn().mockReturnValue(new Promise(() => {})));
    renderMap();

    await user.click(screen.getByRole('button', { name: 'Save Map' }));
    expect(screen.getByRole('button', { name: 'Save Map' })).toBeDisabled();
  });

  it('FE-MOB-SETMAP-016: a failed save surfaces the error message', async () => {
    const user = userEvent.setup();
    seedMap({}, vi.fn().mockRejectedValue(new Error('Storage full')));
    renderMap();

    await user.click(screen.getByRole('button', { name: 'Save Map' }));
    await screen.findByText('Storage full');
    expect(screen.getByRole('button', { name: 'Save Map' })).toBeEnabled();
  });

  it('FE-MOB-SETMAP-017: a settings change from elsewhere re-syncs the local form', async () => {
    renderMap();

    seedMap({ map_tile_url: 'https://tile.openstreetmap.de/{z}/{x}/{y}.png' });

    await waitFor(() =>
      expect(screen.getByDisplayValue('https://tile.openstreetmap.de/{z}/{x}/{y}.png')).toBeInTheDocument(),
    );
    expect(screen.getByText('OpenStreetMap DE')).toBeInTheDocument();
  });

  it('FE-MOB-SETMAP-020: the CARTO key field is offered alongside the template', () => {
    renderMap();

    expect(screen.getByText('CARTO API key')).toBeInTheDocument();
  });

  it('FE-MOB-SETMAP-023: the typed CARTO key reaches the save payload', async () => {
    const user = userEvent.setup();
    const updateSettings = seedMap();
    renderMap();

    await user.type(cartoInput(), 'demo-key');
    await user.click(screen.getByRole('button', { name: 'Save Map' }));

    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ carto_api_key: 'demo-key' }));
  });

  it('FE-MOB-SETMAP-024: a CARTO template without a key explains the watermark until one is typed', async () => {
    const user = userEvent.setup();
    seedMap({ map_tile_url: CARTO_DARK_TILES });
    renderMap();

    expect(screen.getByText(/API KEY REQUIRED/)).toBeInTheDocument();

    await user.type(cartoInput(), 'demo-key');

    expect(screen.queryByText(/API KEY REQUIRED/)).not.toBeInTheDocument();
  });
});
