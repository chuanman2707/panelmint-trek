import React from 'react';
import { describe, it, expect } from 'vitest';
import { useLocation } from 'react-router';
import { render, screen, fireEvent } from '../../helpers/render';
import MBottomNav from '../../../src/mobile/components/MBottomNav';

function LocationEcho() {
  const location = useLocation();
  return <span data-testid="loc">{location.pathname + location.search}</span>;
}

const nav = (entry: string) =>
  render(<><MBottomNav /><LocationEcho /></>, { initialEntries: [entry] });

const at = () => screen.getByTestId('loc').textContent;

// FE-MOB-NAV-001 onwards — the dock holds the dashboard plus the context FAB;
// the addon/plugin items and the More popover are gone with their surfaces.

/** [left group, centre slot, right group] of the dock, in DOM order. */
function dockSlots(container: HTMLElement) {
  const dock = container.querySelector('nav') as HTMLElement;
  const [left, centre, right] = Array.from(dock.children) as HTMLElement[];
  return { count: dock.children.length, left, centre, right };
}

describe('MBottomNav', () => {
  it('FE-MOB-NAV-001: renders the dashboard tab', () => {
    render(<MBottomNav />, { initialEntries: ['/dashboard'] });

    expect(screen.getByRole('button', { name: 'My Trips' })).toBeInTheDocument();
  });

  it('FE-MOB-NAV-003: marks the current route as the active tab', () => {
    render(<MBottomNav />, { initialEntries: ['/settings'] });

    expect(screen.getByRole('button', { name: 'My Trips' })).not.toHaveAttribute('aria-current');
  });

  it('FE-MOB-NAV-004: the "+" creates a trip on the dashboard', () => {
    render(<MBottomNav />, { initialEntries: ['/dashboard'] });
    expect(screen.getByRole('button', { name: 'New Trip' })).toBeInTheDocument();
  });

  it('FE-MOB-NAV-005: the "+" follows the persisted trip tab inside a trip', () => {
    sessionStorage.setItem('trip-tab-7', 'buchungen');
    render(<MBottomNav />, { initialEntries: ['/trips/7'] });
    expect(screen.getByRole('button', { name: 'Manual Booking' })).toBeInTheDocument();
  });

  it('FE-MOB-NAV-007: no More slot — there is nothing left to overflow into it', () => {
    render(<MBottomNav />, { initialEntries: ['/dashboard'] });
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
  });

  it('FE-MOB-NAV-009: settings shows the disabled logo slot instead of a create action', () => {
    render(<MBottomNav />, { initialEntries: ['/settings'] });
    expect(screen.queryByRole('button', { name: 'New Trip' })).not.toBeInTheDocument();
  });

  it.each([
    ['/trips/7', 'Add Place/Activity', '/trips/7?create=place'],
    ['/dashboard', 'New Trip', '/dashboard?create=1'],
  ])('FE-MOB-NAV-014: the "+" on %s runs "%s"', (route, label, target) => {
    nav(route);

    fireEvent.click(screen.getByRole('button', { name: label }));

    expect(at()).toBe(target);
  });

  it.each([
    ['finanzplan', 'Add expense', '/trips/7?create=expense'],
    ['transports', 'Transport', '/trips/7?create=transport'],
    ['buchungen', 'Manual Booking', '/trips/7?create=reservation'],
  ])('FE-MOB-NAV-015: the trip "+" follows the %s tab', (tab, label, target) => {
    sessionStorage.setItem('trip-tab-7', tab);
    nav('/trips/7');

    fireEvent.click(screen.getByRole('button', { name: label }));

    expect(at()).toBe(target);
  });

  it('FE-MOB-NAV-016: the dashboard dock tab navigates to its route', () => {
    nav('/settings');

    // The centre slot is the logo there, so the item sits in the left group.
    fireEvent.click(screen.getByRole('button', { name: 'My Trips' }));

    expect(at()).toBe('/dashboard');
  });

  it('FE-MOB-NAV-019: the settings logo slot keeps the FAB geometry', () => {
    const dashboard = render(<MBottomNav />, { initialEntries: ['/dashboard'] });
    const withFab = dockSlots(dashboard.container);
    const groups = [withFab.left.children.length, withFab.right.children.length];
    const fabClasses = withFab.centre.className.split(' ');
    const slots = withFab.count;
    dashboard.unmount();

    const settings = render(<MBottomNav />, { initialEntries: ['/settings'] });
    const placeholder = dockSlots(settings.container);

    expect(placeholder.count).toBe(slots);
    // Same 56px box as MFab, so both tab groups stay symmetric around the centre.
    ['mx-2', 'h-14', 'w-14', 'flex-none'].forEach((cls) => {
      expect(fabClasses).toContain(cls);
      expect(placeholder.centre).toHaveClass(cls);
    });
    expect([placeholder.left.children.length, placeholder.right.children.length]).toEqual(groups);
  });
});
