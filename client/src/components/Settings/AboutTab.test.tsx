import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '../../../tests/helpers/render';
import { resetAllStores } from '../../../tests/helpers/store';
import AboutTab from './AboutTab';

beforeEach(() => {
  resetAllStores();
  vi.clearAllMocks();
});

describe('AboutTab', () => {
  it('FE-COMP-ABOUT-001: renders without crashing', () => {
    render(<AboutTab appVersion="2.9.10" />);
    expect(document.body).toBeInTheDocument();
  });

  it('FE-COMP-ABOUT-002: displays the version badge', () => {
    render(<AboutTab appVersion="2.9.10" />);
    expect(screen.getByText('v2.9.10')).toBeInTheDocument();
  });

  it('FE-COMP-ABOUT-003: the source-code card links to the PanelMint repo', () => {
    render(<AboutTab appVersion="2.9.10" />);
    const link = screen.getByText('Source code').closest('a');
    expect(link).toHaveAttribute('href', 'https://github.com/chuanman2707/panelmint-trek');
  });

  it('FE-COMP-ABOUT-004: shows the AGPL license note next to the source offer', () => {
    render(<AboutTab appVersion="2.9.10" />);
    expect(screen.getByText(/GNU AGPL v3/)).toBeInTheDocument();
  });

  it('FE-COMP-ABOUT-006: displays bug report link', () => {
    render(<AboutTab appVersion="2.9.10" />);
    const link = document.querySelector('a[href*="issues/new"]');
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', 'https://github.com/chuanman2707/panelmint-trek/issues/new');
  });

  it('FE-COMP-ABOUT-007: displays feature request link', () => {
    render(<AboutTab appVersion="2.9.10" />);
    const link = document.querySelector('a[href*="labels=enhancement"]');
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('FE-COMP-ABOUT-008: the upstream donation, Discord and wiki surfaces are gone', () => {
    render(<AboutTab appVersion="2.9.10" />);
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

  it('FE-COMP-ABOUT-009: all external links have rel="noopener noreferrer"', () => {
    render(<AboutTab appVersion="2.9.10" />);
    const links = document.querySelectorAll('a');
    expect(links).toHaveLength(3);
    links.forEach((link) => {
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });
  });

  it('FE-COMP-ABOUT-010: all external links open in a new tab', () => {
    render(<AboutTab appVersion="2.9.10" />);
    const links = document.querySelectorAll('a');
    links.forEach((link) => {
      expect(link).toHaveAttribute('target', '_blank');
    });
  });

  it('FE-COMP-ABOUT-011: version prop change is reflected', () => {
    render(<AboutTab appVersion="1.0.0" />);
    expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    expect(screen.queryByText('v2.9.10')).toBeNull();
  });
});
