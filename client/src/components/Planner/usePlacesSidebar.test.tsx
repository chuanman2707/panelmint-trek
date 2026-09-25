// FE-PLANNER-PSHOOK-001 to FE-PLANNER-PSHOOK-052
import { http, HttpResponse } from 'msw';
import userEvent from '@testing-library/user-event';
import { render, screen, fireEvent, act, waitFor } from '../../../tests/helpers/render';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildUser, buildTrip, buildPlace, buildDay, buildAssignment } from '../../../tests/helpers/factories';
import { server } from '../../../tests/helpers/msw/server';
import { useAuthStore } from '../../store/authStore';
import { useTripStore } from '../../store/tripStore';
import { usePermissionsStore } from '../../store/permissionsStore';
import { ContextMenu } from '../shared/ContextMenu';
import type { Place } from '../../types';
import { usePlacesSidebar, type PlacesSidebarProps, type SidebarState } from './usePlacesSidebar';

let S: SidebarState;

// The hook owns state that only makes sense against real DOM nodes (the scroll
// container, the per-row refs, the drag counter), so it is driven through a
// stripped-down host instead of renderHook.
function Host(props: PlacesSidebarProps) {
  const state = usePlacesSidebar(props);
  S = state;
  return (
    <div
      data-testid="sidebar"
      ref={state.scrollContainerRef}
    >
      {state.filtered.map((p) => (
        <div
          key={p.id}
          data-testid={`row-${p.id}`}
          ref={(el) => { state.registerPlaceRow(p.id, el); }}
          onContextMenu={(e) => state.openContextMenu(e, p)}
        >
          {p.name}
        </div>
      ))}
      <ContextMenu menu={state.ctxMenu.menu} onClose={state.ctxMenu.close} />
    </div>
  );
}

function makeProps(overrides: Partial<PlacesSidebarProps> = {}): PlacesSidebarProps {
  return {
    tripId: 1,
    places: [],
    categories: [],
    assignments: {},
    selectedDayId: null,
    selectedPlaceId: null,
    onPlaceClick: vi.fn((_id: number | null) => {}),
    onAddPlace: vi.fn(() => {}),
    onAssignToDay: vi.fn((_placeId: number, _dayId: number) => {}),
    onEditPlace: vi.fn((_place: Place) => {}),
    onDeletePlace: vi.fn((_placeId: number) => {}),
    days: [],
    isMobile: false,
    ...overrides,
  };
}

function names(): string[] {
  return S.filtered.map((p) => p.name);
}

const addToast = vi.fn((_message: string, _type?: string, _duration?: number) => 0);

beforeEach(() => {
  resetAllStores();
  seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true });
  seedStore(useTripStore, { trip: buildTrip({ id: 1 }) });
  addToast.mockClear();
  window.__addToast = addToast;
});

afterEach(() => {
  delete window.__addToast;
  vi.unstubAllGlobals();
});

// ── Filtering, search and sorting ─────────────────────────────────────────────

describe('usePlacesSidebar filtering', () => {
  it('FE-PLANNER-PSHOOK-001: passes every place through when nothing is filtered', () => {
    const places = [buildPlace({ name: 'Alpha' }), buildPlace({ name: 'Beta' })];
    render(<Host {...makeProps({ places })} />);
    expect(names()).toEqual(['Alpha', 'Beta']);
    expect(S.hasTracks).toBe(false);
  });

  it('FE-PLANNER-PSHOOK-002: search matches the name case-insensitively', () => {
    const places = [buildPlace({ name: 'Museum of Art' }), buildPlace({ name: 'Central Park' })];
    render(<Host {...makeProps({ places })} />);
    act(() => { S.setSearch('MUSEUM'); });
    expect(names()).toEqual(['Museum of Art']);
  });

  it('FE-PLANNER-PSHOOK-003: search also matches the address', () => {
    const places = [
      buildPlace({ name: 'UK Office', address: '10 Downing Street' }),
      buildPlace({ name: 'Other', address: null }),
    ];
    render(<Host {...makeProps({ places })} />);
    act(() => { S.setSearch('downing'); });
    expect(names()).toEqual(['UK Office']);
  });

  it('FE-PLANNER-PSHOOK-004: a search that matches nothing empties the list', () => {
    const places = [buildPlace({ name: 'Alpha', address: 'Rue A' })];
    render(<Host {...makeProps({ places })} />);
    act(() => { S.setSearch('zzz'); });
    expect(names()).toEqual([]);
  });

  it('FE-PLANNER-PSHOOK-005: the unplanned filter drops places assigned to a day', () => {
    const planned = buildPlace({ id: 1, name: 'Planned' });
    const loose = buildPlace({ id: 2, name: 'Loose' });
    const assignments = { '3': [buildAssignment({ place: planned, day_id: 3 })] };
    render(<Host {...makeProps({ places: [planned, loose], assignments })} />);
    act(() => { S.setFilter('unplanned'); });
    expect(names()).toEqual(['Loose']);
    expect([...S.plannedIds]).toEqual([1]);
  });

  // #2072 — a hotel is linked through its stay, never dragged onto a day, so the
  // pool called it unplanned while the day header printed its name.
  it('FE-PLANNER-PSHOOK-049: a place linked to a stay counts as planned', () => {
    const hotel = buildPlace({ id: 1, name: 'Hotel' });
    const loose = buildPlace({ id: 2, name: 'Loose' });
    const accommodations = [{ place_id: 1, start_day_id: 3, end_day_id: 5 }];
    render(<Host {...makeProps({ places: [hotel, loose], accommodations })} />);

    act(() => { S.setFilter('unplanned'); });
    expect(names()).toEqual(['Loose']);
    act(() => { S.setFilter('planned'); });
    expect(names()).toEqual(['Hotel']);
  });

  it('FE-PLANNER-PSHOOK-050: a place on a day-anchored booking counts as planned', () => {
    const venue = buildPlace({ id: 1, name: 'Venue' });
    const loose = buildPlace({ id: 2, name: 'Loose' });
    seedStore(useTripStore, { reservations: [{ id: 9, place_id: 1, day_id: 3 }] });
    render(<Host {...makeProps({ places: [venue, loose] })} />);

    act(() => { S.setFilter('unplanned'); });
    expect(names()).toEqual(['Loose']);
  });

  it('FE-PLANNER-PSHOOK-051: a booking with no day leaves its place unplanned', () => {
    const venue = buildPlace({ id: 1, name: 'Venue' });
    seedStore(useTripStore, { reservations: [{ id: 9, place_id: 1, day_id: null }] });
    render(<Host {...makeProps({ places: [venue] })} />);

    act(() => { S.setFilter('unplanned'); });
    expect(names()).toEqual(['Venue']);
  });

  it('FE-PLANNER-PSHOOK-006: the planned filter keeps only assigned places', () => {
    const planned = buildPlace({ id: 1, name: 'Planned' });
    const loose = buildPlace({ id: 2, name: 'Loose' });
    const assignments = { '3': [buildAssignment({ place: planned, day_id: 3 })] };
    render(<Host {...makeProps({ places: [planned, loose], assignments })} />);
    act(() => { S.setFilter('planned'); });
    expect(names()).toEqual(['Planned']);
  });

  it('FE-PLANNER-PSHOOK-007: the tracks filter keeps only places carrying route geometry', () => {
    const track = buildPlace({ name: 'GPX Track', route_geometry: '[[48,2],[49,3]]' });
    const spot = buildPlace({ name: 'Plain Spot' });
    render(<Host {...makeProps({ places: [track, spot] })} />);
    expect(S.hasTracks).toBe(true);
    act(() => { S.setFilter('tracks'); });
    expect(names()).toEqual(['GPX Track']);
  });

  it('FE-PLANNER-PSHOOK-008: a tracks filter without any track falls back to "all"', async () => {
    seedStore(useTripStore, { placesFilter: 'tracks' });
    render(<Host {...makeProps({ places: [buildPlace({ name: 'Plain Spot' })] })} />);
    await waitFor(() => expect(useTripStore.getState().placesFilter).toBe('all'));
    expect(names()).toEqual(['Plain Spot']);
  });

  it('FE-PLANNER-PSHOOK-009: a category filter keeps only that category', () => {
    const tagged = buildPlace({ name: 'Tagged', category_id: 4 });
    const other = buildPlace({ name: 'Other', category_id: 5 });
    const none = buildPlace({ name: 'None', category_id: null });
    render(<Host {...makeProps({ places: [tagged, other, none] })} />);
    act(() => { S.setCategoryFilters(new Set(['4'])); });
    expect(names()).toEqual(['Tagged']);
  });

  it('FE-PLANNER-PSHOOK-010: the "uncategorized" bucket keeps only places without a category', () => {
    const tagged = buildPlace({ name: 'Tagged', category_id: 4 });
    const none = buildPlace({ name: 'None', category_id: null });
    render(<Host {...makeProps({ places: [tagged, none] })} />);
    act(() => { S.setCategoryFilters(new Set(['uncategorized'])); });
    expect(names()).toEqual(['None']);
  });

  it('FE-PLANNER-PSHOOK-011: toggleCategoryFilter adds and removes a category', () => {
    render(<Host {...makeProps()} />);
    act(() => { S.toggleCategoryFilter('7'); });
    expect([...useTripStore.getState().placesCategoryFilter]).toEqual(['7']);
    act(() => { S.toggleCategoryFilter('7'); });
    expect([...useTripStore.getState().placesCategoryFilter]).toEqual([]);
  });

  it('FE-PLANNER-PSHOOK-012: the star filter keeps everything at or above the floor', () => {
    const places = [
      buildPlace({ name: 'Unrated' }),
      buildPlace({ name: 'Good', rating_avg: 4.2 }),
      buildPlace({ name: 'Best', rating_avg: 4.9 }),
      buildPlace({ name: 'Meh', rating_avg: 2.5 }),
    ];
    render(<Host {...makeProps({ places })} />);
    act(() => { S.setRatingFilter(4); });
    // The list keeps its own order; the filter only decides who is on it.
    expect(names()).toEqual(['Good', 'Best']);
  });

  it('FE-PLANNER-PSHOOK-013: an unrated place drops out as soon as a floor is set, and comes back with "all"', () => {
    const places = [
      buildPlace({ name: 'Unrated' }),
      buildPlace({ name: 'Rated', rating_avg: 1 }),
    ];
    render(<Host {...makeProps({ places })} />);
    act(() => { S.setRatingFilter(1); });
    expect(names()).toEqual(['Rated']);
    act(() => { S.setRatingFilter('all'); });
    expect(names()).toEqual(['Unrated', 'Rated']);
  });

  it('FE-PLANNER-PSHOOK-014: search and category filter combine', () => {
    const places = [
      buildPlace({ name: 'Cafe Nord', category_id: 4 }),
      buildPlace({ name: 'Cafe Sud', category_id: 5 }),
      buildPlace({ name: 'Bar Nord', category_id: 4 }),
    ];
    render(<Host {...makeProps({ places })} />);
    act(() => {
      S.setCategoryFilters(new Set(['4']));
      S.setSearch('cafe');
    });
    expect(names()).toEqual(['Cafe Nord']);
  });
});

// ── Multi-select ──────────────────────────────────────────────────────────────

describe('usePlacesSidebar selection', () => {
  it('FE-PLANNER-PSHOOK-015: toggleSelected adds and removes an id', () => {
    render(<Host {...makeProps({ places: [buildPlace({ id: 9 })] })} />);
    act(() => { S.toggleSelected(9); });
    expect([...S.selectedIds]).toEqual([9]);
    act(() => { S.toggleSelected(9); });
    expect([...S.selectedIds]).toEqual([]);
  });

  it('FE-PLANNER-PSHOOK-016: exitSelectMode clears the mode and the selection', () => {
    render(<Host {...makeProps({ places: [buildPlace({ id: 9 })] })} />);
    act(() => { S.setSelectMode(true); S.toggleSelected(9); });
    expect(S.selectMode).toBe(true);
    act(() => { S.exitSelectMode(); });
    expect(S.selectMode).toBe(false);
    expect(S.selectedIds.size).toBe(0);
  });

  it('FE-PLANNER-PSHOOK-017: select mode ends by itself once every selected place is gone', () => {
    const a = buildPlace({ id: 1, name: 'A' });
    const b = buildPlace({ id: 2, name: 'B' });
    const { rerender } = render(<Host {...makeProps({ places: [a, b] })} />);
    act(() => { S.setSelectMode(true); S.toggleSelected(1); });

    rerender(<Host {...makeProps({ places: [b] })} />);

    expect(S.selectMode).toBe(false);
    expect(S.selectedIds.size).toBe(0);
  });

  it('FE-PLANNER-PSHOOK-018: select mode survives while one selected place is still there', () => {
    const a = buildPlace({ id: 1, name: 'A' });
    const b = buildPlace({ id: 2, name: 'B' });
    const { rerender } = render(<Host {...makeProps({ places: [a, b] })} />);
    act(() => { S.setSelectMode(true); S.toggleSelected(1); S.toggleSelected(2); });

    rerender(<Host {...makeProps({ places: [a] })} />);

    expect(S.selectMode).toBe(true);
    expect([...S.selectedIds].sort()).toEqual([1, 2]);
  });
});

// ── Day assignment helpers ────────────────────────────────────────────────────

describe('usePlacesSidebar day helpers', () => {
  it('FE-PLANNER-PSHOOK-019: isAssignedToSelectedDay and inDaySet reflect the selected day', () => {
    const place = buildPlace({ id: 5, name: 'Assigned' });
    const assignments = { '3': [buildAssignment({ place, day_id: 3 })] };
    render(<Host {...makeProps({ places: [place], assignments, selectedDayId: 3 })} />);

    expect(S.isAssignedToSelectedDay(5)).toBe(true);
    expect(S.isAssignedToSelectedDay(99)).toBe(false);
    expect([...S.inDaySet]).toEqual([5]);
  });

  it('FE-PLANNER-PSHOOK-020: without a selected day nothing counts as assigned', () => {
    const place = buildPlace({ id: 5 });
    const assignments = { '3': [buildAssignment({ place, day_id: 3 })] };
    render(<Host {...makeProps({ places: [place], assignments, selectedDayId: null })} />);

    expect(S.isAssignedToSelectedDay(5)).toBeFalsy();
    expect(S.inDaySet.size).toBe(0);
  });

  it('FE-PLANNER-PSHOOK-021: a day without assignments yields an empty set', () => {
    const place = buildPlace({ id: 5 });
    render(<Host {...makeProps({ places: [place], assignments: {}, selectedDayId: 8 })} />);
    expect(S.inDaySet.size).toBe(0);
    expect(S.isAssignedToSelectedDay(5)).toBe(false);
  });

  it('FE-PLANNER-PSHOOK-052: the stop a booking wrote counts as in the day when the list hides it', () => {
    // The day view hands the pool the day without the stop a booking wrote, while
    // the store still holds it. Judged on the list alone the hotel offered "add to
    // day" on its own check-in day, and that put a second row beside the night.
    const hotel = buildPlace({ id: 5, name: 'Hotel' });
    const loose = buildPlace({ id: 6, name: 'Loose' });
    const booked = buildAssignment({ place: hotel, day_id: 3, accommodation_id: 4 });
    seedStore(useTripStore, { assignments: { '3': [booked] } });
    render(<Host {...makeProps({ places: [hotel, loose], assignments: { '3': [] }, selectedDayId: 3 })} />);

    expect([...S.inDaySet]).toEqual([5]);
    expect(S.isAssignedToSelectedDay(5)).toBe(true);
    expect(S.isAssignedToSelectedDay(6)).toBe(false);
  });
});

// ── Scroll restoration and row refs ───────────────────────────────────────────

describe('usePlacesSidebar scrolling', () => {
  it('FE-PLANNER-PSHOOK-022: restores the previous scroll offset on mount', () => {
    render(<Host {...makeProps({ places: [buildPlace()], initialScrollTop: 240 })} />);
    expect(screen.getByTestId('sidebar').scrollTop).toBe(240);
  });

  it('FE-PLANNER-PSHOOK-023: a zero offset leaves the container untouched', () => {
    render(<Host {...makeProps({ places: [buildPlace()], initialScrollTop: 0 })} />);
    expect(screen.getByTestId('sidebar').scrollTop).toBe(0);
  });

  it('FE-PLANNER-PSHOOK-024: the selected row is scrolled into view exactly once', async () => {
    const scrollIntoView = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>;
    scrollIntoView.mockClear();
    const places = [buildPlace({ id: 1, name: 'A' }), buildPlace({ id: 2, name: 'B' })];
    const { rerender } = render(<Host {...makeProps({ places, selectedPlaceId: 2 })} />);

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' }));
    scrollIntoView.mockClear();

    // Re-rendering with the same selection must not scroll again.
    rerender(<Host {...makeProps({ places, selectedPlaceId: 2 })} />);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('FE-PLANNER-PSHOOK-025: clearing the selection resets the auto-scroll guard', async () => {
    const scrollIntoView = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>;
    const places = [buildPlace({ id: 1, name: 'A' }), buildPlace({ id: 2, name: 'B' })];
    const { rerender } = render(<Host {...makeProps({ places, selectedPlaceId: 2 })} />);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());

    rerender(<Host {...makeProps({ places, selectedPlaceId: null })} />);
    scrollIntoView.mockClear();
    rerender(<Host {...makeProps({ places, selectedPlaceId: 2 })} />);

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
  });

  it('FE-PLANNER-PSHOOK-026: a selected place filtered out of the list is not scrolled to', () => {
    const scrollIntoView = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>;
    const places = [buildPlace({ id: 1, name: 'Visible' }), buildPlace({ id: 2, name: 'Hidden' })];
    const { rerender } = render(<Host {...makeProps({ places, selectedPlaceId: null })} />);
    act(() => { S.setSearch('Visible'); });
    scrollIntoView.mockClear();

    // The row is unmounted by the search, so registerPlaceRow has dropped its ref.
    rerender(<Host {...makeProps({ places, selectedPlaceId: 2 })} />);

    expect(names()).toEqual(['Visible']);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

// ── Drag & drop import ────────────────────────────────────────────────────────

// ── Row context menu ──────────────────────────────────────────────────────────

describe('usePlacesSidebar context menu', () => {
  it('FE-PLANNER-PSHOOK-042: a full-permission row offers edit, day, website, maps and delete', () => {
    const place = buildPlace({ id: 3, name: 'Cafe', website: 'https://cafe.example', google_place_id: 'ChIJ1' });
    render(<Host {...makeProps({ places: [place], selectedDayId: 6 })} />);

    fireEvent.contextMenu(screen.getByTestId('row-3'));

    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Day' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Website' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Google Maps' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('FE-PLANNER-PSHOOK-043: a read-only row without extras only offers the maps link', () => {
    seedStore(usePermissionsStore, { permissions: { place_edit: 'admin' } });
    const place = buildPlace({ id: 3, name: 'Cafe', website: null });
    render(<Host {...makeProps({ places: [place], selectedDayId: null })} />);

    fireEvent.contextMenu(screen.getByTestId('row-3'));

    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Day' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Website' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save to Collection' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Google Maps' })).toBeInTheDocument();
  });

  it('FE-PLANNER-PSHOOK-044: Edit hands the place back to the planner', async () => {
    const user = userEvent.setup();
    const onEditPlace = vi.fn((_place: Place) => {});
    const place = buildPlace({ id: 3, name: 'Cafe' });
    render(<Host {...makeProps({ places: [place], onEditPlace })} />);

    fireEvent.contextMenu(screen.getByTestId('row-3'));
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    expect(onEditPlace).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }));
  });

  it('FE-PLANNER-PSHOOK-045: "+ Day" uses the day that was selected when the menu opened', async () => {
    const user = userEvent.setup();
    const onAssignToDay = vi.fn((_placeId: number, _dayId: number) => {});
    const place = buildPlace({ id: 3, name: 'Cafe' });
    const days = [buildDay({ id: 6 })];
    render(<Host {...makeProps({ places: [place], days, selectedDayId: 6, onAssignToDay })} />);

    fireEvent.contextMenu(screen.getByTestId('row-3'));
    await user.click(screen.getByRole('button', { name: '+ Day' }));

    expect(onAssignToDay).toHaveBeenCalledWith(3, 6);
  });

  it('FE-PLANNER-PSHOOK-046: Delete hands the id back to the planner', async () => {
    const user = userEvent.setup();
    const onDeletePlace = vi.fn((_placeId: number) => {});
    const place = buildPlace({ id: 3, name: 'Cafe' });
    render(<Host {...makeProps({ places: [place], onDeletePlace })} />);

    fireEvent.contextMenu(screen.getByTestId('row-3'));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(onDeletePlace).toHaveBeenCalledWith(3);
  });

  it('FE-PLANNER-PSHOOK-047: Website and Google Maps open a new tab', async () => {
    const user = userEvent.setup();
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    const place = buildPlace({ id: 3, name: 'Cafe', website: 'https://cafe.example', lat: 48.8584, lng: 2.2945, google_place_id: null });
    render(<Host {...makeProps({ places: [place] })} />);

    fireEvent.contextMenu(screen.getByTestId('row-3'));
    await user.click(screen.getByRole('button', { name: 'Open Website' }));
    expect(open).toHaveBeenCalledWith('https://cafe.example', '_blank', 'noopener,noreferrer');

    fireEvent.contextMenu(screen.getByTestId('row-3'));
    await user.click(screen.getByRole('button', { name: 'Google Maps' }));
    expect(open).toHaveBeenCalledWith('https://www.google.com/maps/search/?api=1&query=48.8584,2.2945', '_blank');
  });

  });
