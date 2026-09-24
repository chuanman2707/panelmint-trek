import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '../../tests/helpers/render';
import userEvent from '@testing-library/user-event';
import { resetAllStores, seedStore } from '../../tests/helpers/store';
import { buildUser } from '../../tests/helpers/factories';
import { useAuthStore } from '../store/authStore';
import SettingsPage from './SettingsPage';

// Mock heavy settings sub-tabs to focus on page-level concerns
vi.mock('../components/Settings/DisplaySettingsTab', () => ({
  default: () => <div data-testid="display-settings-tab">Display Settings</div>,
}));

vi.mock('../components/Settings/MapSettingsTab', () => ({
  default: () => <div data-testid="map-settings-tab">Map Settings</div>,
}));

vi.mock('../components/Settings/AppearanceSettingsTab', () => ({
  default: () => <div data-testid="appearance-settings-tab">Appearance Settings</div>,
}));

vi.mock('../components/Settings/AboutTab', () => ({
  default: ({ appVersion }: { appVersion: string }) => (
    <div data-testid="about-tab">About v{appVersion}</div>
  ),
}));

beforeEach(() => {
  resetAllStores();
  seedStore(useAuthStore, { isAuthenticated: true, user: buildUser() });
});

describe('SettingsPage', () => {
  describe('FE-PAGE-SETTINGS-001: Settings page renders', () => {
    it('shows the Settings heading', () => {
      render(<SettingsPage />);
      expect(screen.getByRole('heading', { name: /settings/i })).toBeInTheDocument();
    });
  });

  describe('FE-PAGE-SETTINGS-002: Default tab (Display) is active', () => {
    it('shows Display tab content by default', async () => {
      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('display-settings-tab')).toBeInTheDocument();
      });
    });
  });

  describe('FE-PAGE-SETTINGS-003: Tab navigation', () => {
    it('switching to Map tab shows map settings content', async () => {
      const user = userEvent.setup();
      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /map/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /^map$/i }));

      await waitFor(() => {
        expect(screen.getByTestId('map-settings-tab')).toBeInTheDocument();
      });
    });

    it('switching to Appearance tab shows appearance settings', async () => {
      const user = userEvent.setup();
      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /appearance/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /appearance/i }));

      await waitFor(() => {
        expect(screen.getByTestId('appearance-settings-tab')).toBeInTheDocument();
      });
    });

  });

  describe('FE-PAGE-SETTINGS-004: All standard tabs are present', () => {
    it('renders General, Appearance, Map tabs', async () => {
      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /general/i })).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: /appearance/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^map$/i })).toBeInTheDocument();
      // The hosted account/integrations/notifications tabs are gone in the
      // local build.
      expect(screen.queryByRole('button', { name: /account/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /notifications/i })).not.toBeInTheDocument();
    });
  });

  describe('FE-PAGE-SETTINGS-006: About tab shown when version loads', () => {
    it('About tab appears when app version is returned by API', async () => {
      const { http, HttpResponse } = await import('msw');
      const { server } = await import('../../tests/helpers/msw/server');

      server.use(
        http.get('/api/auth/app-config', () => {
          return HttpResponse.json({
            has_users: true,
            allow_registration: true,
            demo_mode: false,
            oidc_configured: false,
            oidc_only_mode: false,
            version: '2.9.10',
          });
        }),
      );

      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /about/i })).toBeInTheDocument();
      });
    });
  });
});
