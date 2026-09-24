// FE-MOB-SET-NAV-001 onwards
import { describe, it, expect, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '../../../helpers/render';
import { resetAllStores, seedStore } from '../../../helpers/store';
import { buildSettings } from '../../../helpers/factories';
import { useSettingsStore } from '../../../../src/store/settingsStore';
import { usePluginStore } from '../../../../src/store/pluginStore';
import MSettings from '../../../../src/mobile/screens/settings/MSettings';

describe('MSettings', () => {
  beforeEach(() => {
    resetAllStores();
    seedStore(useSettingsStore, { settings: buildSettings({ language: 'en' }) });
    usePluginStore.setState({ plugins: [], loaded: true });
  });

  it('FE-MOB-SET-NAV-001: opens on General with the section switcher pill', () => {
    render(<MSettings />, { initialEntries: ['/settings'] });

    expect(screen.getByRole('button', { name: /General/ })).toBeInTheDocument();
    expect(screen.getByText('Language & region')).toBeInTheDocument();
  });

  it('FE-MOB-SET-NAV-002: the dropdown lists the sections and switches on tap', async () => {
    const user = userEvent.setup();
    render(<MSettings />, { initialEntries: ['/settings'] });

    await user.click(screen.getByRole('button', { name: /General/ }));
    expect(screen.getByRole('button', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Map' })).toBeInTheDocument();
    // The hosted Account and Notifications sections are gone in the local build.
    expect(screen.queryByRole('button', { name: 'Account' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Notifications' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Map' }));
    // Pill now shows the active section (exact name — the Map card itself holds
    // a "Map Template" button); the General card is gone.
    expect(screen.getByRole('button', { name: 'Map' })).toBeInTheDocument();
    expect(screen.queryByText('Language & region')).not.toBeInTheDocument();
  });
});
