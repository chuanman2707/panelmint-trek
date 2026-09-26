// FE-MOB-SETABOUT-001 onwards — mobile twin of components/Settings/AboutTab.test.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '../../../helpers/render';
import { resetAllStores } from '../../../helpers/store';
import MSettingsAbout from '../../../../src/mobile/screens/settings/MSettingsAbout';

describe('MSettingsAbout', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('FE-MOB-SETABOUT-001: renders the version badge and description', () => {
    render(<MSettingsAbout appVersion="2.9.10" />);

    expect(screen.getByText('v2.9.10')).toBeInTheDocument();
    expect(screen.getByText(/PanelMint is/)).toBeInTheDocument();
  });

  it('FE-MOB-SETABOUT-002: the source-code row links to the PanelMint repo with the AGPL note', () => {
    render(<MSettingsAbout appVersion="2.9.10" />);

    const link = screen.getByText('Source code').closest('a');
    expect(link).toHaveAttribute('href', 'https://github.com/chuanman2707/panelmint-trek');
    expect(screen.getByText(/GNU AGPL v3/)).toBeInTheDocument();
  });

  it('FE-MOB-SETABOUT-003: keeps the bug and feature-request links on the fork repo', () => {
    render(<MSettingsAbout appVersion="2.9.10" />);

    expect(document.querySelector('a[href*="issues/new"]')).toHaveAttribute(
      'href',
      'https://github.com/chuanman2707/panelmint-trek/issues/new',
    );
    expect(document.querySelector('a[href*="labels=enhancement"]')).toBeInTheDocument();
  });

  it('FE-MOB-SETABOUT-004: the upstream donation, Discord and wiki links are gone', () => {
    render(<MSettingsAbout appVersion="2.9.10" />);

    expect(screen.queryByText('Ko-fi')).toBeNull();
    expect(screen.queryByText('Buy Me a Coffee')).toBeNull();
    expect(screen.queryByText('Discord')).toBeNull();
    expect(screen.queryByText('Wiki')).toBeNull();
    for (const sel of [
      'a[href*="ko-fi"]',
      'a[href*="buymeacoffee"]',
      'a[href*="discord"]',
      'a[href*="wiki"]',
      'a[href*="liketrek"]',
      'a[href*="mauriceboe"]',
    ]) {
      expect(document.querySelector(sel), sel).toBeNull();
    }
  });

  it('FE-MOB-SETABOUT-005: every link opens in a new tab with noreferrer', () => {
    render(<MSettingsAbout appVersion="2.9.10" />);

    const links = document.querySelectorAll('a');
    expect(links).toHaveLength(3);
    links.forEach((link) => {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });
  });
});
