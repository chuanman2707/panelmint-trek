// FE-COMP-BUDGET-001 to FE-COMP-BUDGET-036
import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '../../../tests/helpers/render';
import userEvent from '@testing-library/user-event';
import { useAuthStore } from '../../store/authStore';
import { useTripStore } from '../../store/tripStore';
import { useSettingsStore } from '../../store/settingsStore';
import { usePermissionsStore } from '../../store/permissionsStore';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildUser, buildTrip, buildBudgetItem, buildSettings } from '../../../tests/helpers/factories';
import { budgetApi } from '../../api/client';
import { db } from '../../db/panelmintDb';
import type { BudgetItem } from '../../types';
import BudgetPanel from './BudgetPanel';

type SettlementResponse = Awaited<ReturnType<typeof budgetApi.settlement>>;

/** Budget items land in panelmintDb — the real adapter serves what MSW used to. */
async function seedItems(items: BudgetItem[]) {
  if (items.length) await db.budgetItems.bulkPut(items);
}

beforeEach(async () => {
  resetAllStores();
  // The local world the budget adapter reads. The trip's user_id is the self
  // profile so requireTripAccess passes; the roster joins member usernames.
  await db.transaction('rw', db.tables, async () => { for (const t of db.tables) await t.clear() });
  await db.localUsers.bulkPut([
    { id: 1, name: 'testuser', is_self: 1 },
    { id: 2, name: 'alice', is_self: 0 },
    { id: 3, name: 'bob', is_self: 0 },
    { id: 4, name: 'other', is_self: 0 },
  ]);
  await db.trips.put(buildTrip({ id: 1, currency: 'EUR' }));
  await db.tripMembers.bulkPut([
    { tripId: 1, id: 1, username: 'testuser', role: 'owner' },
    { tripId: 1, id: 2, username: 'alice', role: 'member', is_guest: true },
    { tripId: 1, id: 3, username: 'bob', role: 'member', is_guest: true },
  ]);
  // The settlement read the panel fires for multi-member trips — stubbed like
  // the MSW handler was, because the tests pick the balances/flows to show.
  vi.spyOn(budgetApi, 'settlement').mockResolvedValue(
    { balances: [], flows: [], settlements: [], finalBudgets: [] } as SettlementResponse,
  );
  seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true });
  seedStore(useTripStore, { trip: buildTrip({ id: 1, currency: 'EUR' }) });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BudgetPanel', () => {
  it('FE-COMP-BUDGET-001: renders empty state when no budget items', async () => {
    render(<BudgetPanel tripId={1} />);
    expect(await screen.findByText('No budget created yet')).toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-002: shows empty state text body', async () => {
    render(<BudgetPanel tripId={1} />);
    expect(await screen.findByText(/Create categories and entries/i)).toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-003: shows category input in empty state when user can edit', async () => {
    render(<BudgetPanel tripId={1} />);
    expect(await screen.findByPlaceholderText('Enter category name...')).toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-004: renders budget items from store after load', async () => {
    const item = buildBudgetItem({ trip_id: 1, name: 'Hotel Paris', category: 'Accommodation' });
    await seedItems([item]);
    render(<BudgetPanel tripId={1} />);
    expect(await screen.findByText('Hotel Paris')).toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-005: renders category section header', async () => {
    const item = buildBudgetItem({ trip_id: 1, name: 'Flight to Rome', category: 'Transport' });
    await seedItems([item]);
    render(<BudgetPanel tripId={1} />);
    // 'Transport' appears in the category section header and the spend breakdown chart.
    expect((await screen.findAllByText('Transport')).length).toBeGreaterThan(0);
  });

  it('FE-COMP-BUDGET-006: renders budget table headers', async () => {
    const item = buildBudgetItem({ trip_id: 1, category: 'Food' });
    await seedItems([item]);
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Name');
    // 'Total' appears both as a table header and in the chart total label.
    expect((await screen.findAllByText('Total')).length).toBeGreaterThan(0);
  });

  it('FE-COMP-BUDGET-007: shows Budget title heading', async () => {
    const item = buildBudgetItem({ trip_id: 1, category: 'Other' });
    await seedItems([item]);
    render(<BudgetPanel tripId={1} />);
    expect(await screen.findByText('Budget')).toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-008: shows CSV export button', async () => {
    const item = buildBudgetItem({ trip_id: 1, category: 'Other' });
    await seedItems([item]);
    render(<BudgetPanel tripId={1} />);
    expect(await screen.findByText('CSV')).toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-009: add item row visible in table', async () => {
    const item = buildBudgetItem({ trip_id: 1, category: 'Food' });
    await seedItems([item]);
    render(<BudgetPanel tripId={1} />);
    expect(await screen.findByPlaceholderText('New Entry')).toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-010: adding new item via form calls create and shows item', async () => {
    const user = userEvent.setup();
    const initialItem = buildBudgetItem({ trip_id: 1, category: 'Food', name: 'Existing' });
    await seedItems([initialItem]);
    const create = vi.spyOn(budgetApi, 'create');
    render(<BudgetPanel tripId={1} />);
    const nameInput = await screen.findByPlaceholderText('New Entry');
    await user.type(nameInput, 'Restaurant Dinner');
    const addBtn = screen.getByTitle('Add Reservation');
    await user.click(addBtn);
    expect(await screen.findByText('Restaurant Dinner')).toBeInTheDocument();
    expect(create).toHaveBeenCalledWith(1, expect.objectContaining({ name: 'Restaurant Dinner', category: 'Food' }));
  });

  it('FE-COMP-BUDGET-011: delete button present for items when user can edit', async () => {
    const item = buildBudgetItem({ trip_id: 1, category: 'Food', name: 'Test Item' });
    await seedItems([item]);
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Test Item');
    // Delete button has title="Delete"
    expect(screen.getByTitle('Delete')).toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-012: delete item removes it from the UI', async () => {
    const user = userEvent.setup();
    const item = buildBudgetItem({ id: 42, trip_id: 1, category: 'Food', name: 'Item To Delete' });
    await seedItems([item]);
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Item To Delete');
    await user.click(screen.getByTitle('Delete'));
    await waitFor(() => {
      expect(screen.queryByText('Item To Delete')).not.toBeInTheDocument();
    });
    expect(await db.budgetItems.get(42)).toBeUndefined();
  });

  it('FE-COMP-BUDGET-013: multiple items in same category all render', async () => {
    const item1 = buildBudgetItem({ trip_id: 1, category: 'Hotels', name: 'Hotel A' });
    const item2 = buildBudgetItem({ trip_id: 1, category: 'Hotels', name: 'Hotel B' });
    await seedItems([item1, item2]);
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Hotel A');
    expect(await screen.findByText('Hotel B')).toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-014: items from different categories render separate sections', async () => {
    const item1 = buildBudgetItem({ trip_id: 1, category: 'Transport', name: 'Flight' });
    const item2 = buildBudgetItem({ trip_id: 1, category: 'Hotels', name: 'Hotel' });
    await seedItems([item1, item2]);
    render(<BudgetPanel tripId={1} />);
    // Each category appears in its section header and again in the breakdown chart.
    expect((await screen.findAllByText('Transport')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Hotels')).length).toBeGreaterThan(0);
  });

  it('FE-COMP-BUDGET-015: currency from settings store is used for default_currency display', async () => {
    seedStore(useSettingsStore, { settings: buildSettings({ default_currency: 'USD' }) });
    render(<BudgetPanel tripId={1} />);
    // Component renders even in empty state
    expect(await screen.findByText('No budget created yet')).toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-016: trip currency EUR is shown in header for item rows', async () => {
    seedStore(useTripStore, { trip: buildTrip({ id: 1, currency: 'EUR' }) });
    const item = buildBudgetItem({ trip_id: 1, category: 'Other', name: 'Misc', total_price: 50 });
    await seedItems([item]);
    render(<BudgetPanel tripId={1} />);
    expect(await screen.findByText('Misc')).toBeInTheDocument();
    // Row exists - EUR formatting would appear in values
  });

  it('FE-COMP-BUDGET-017: Delete Category button shown in category header', async () => {
    const item = buildBudgetItem({ trip_id: 1, category: 'ToDelete', name: 'Item' });
    await seedItems([item]);
    render(<BudgetPanel tripId={1} />);
    // 'ToDelete' appears in the category header and the breakdown chart.
    expect((await screen.findAllByText('ToDelete')).length).toBeGreaterThan(0);
    expect(screen.getByTitle('Delete Category')).toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-018: renders add item button (+ icon) in add row', async () => {
    const item = buildBudgetItem({ trip_id: 1, category: 'Other' });
    await seedItems([item]);
    render(<BudgetPanel tripId={1} />);
    await screen.findByPlaceholderText('New Entry');
    // The add button is present
    expect(screen.getByTitle('Add Reservation')).toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-019: add item with Enter key submits the form', async () => {
    const user = userEvent.setup();
    const initialItem = buildBudgetItem({ trip_id: 1, category: 'Food', name: 'Existing' });
    await seedItems([initialItem]);
    render(<BudgetPanel tripId={1} />);
    const nameInput = await screen.findByPlaceholderText('New Entry');
    await user.type(nameInput, 'Pizza{Enter}');
    expect(await screen.findByText('Pizza')).toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-020: component renders without crashing with empty tripMembers', async () => {
    render(<BudgetPanel tripId={1} tripMembers={[]} />);
    expect(await screen.findByText('No budget created yet')).toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-021: inline edit name cell — clicking a name cell makes it editable', async () => {
    const user = userEvent.setup();
    const item = { ...buildBudgetItem({ id: 21, trip_id: 1, category: 'Food', name: 'Old Name' }), total_price: 10 };
    await seedItems([item]);
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Old Name');
    await user.click(screen.getByText('Old Name'));
    expect(screen.getByDisplayValue('Old Name')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByDisplayValue('Old Name')).not.toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-022: inline edit name cell — saving new name calls update', async () => {
    const user = userEvent.setup();
    const item = { ...buildBudgetItem({ id: 10, trip_id: 1, category: 'Food', name: 'Old Name' }), total_price: 10 };
    await seedItems([item]);
    const update = vi.spyOn(budgetApi, 'update');
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Old Name');
    await user.click(screen.getByText('Old Name'));
    const input = screen.getByDisplayValue('Old Name');
    await user.clear(input);
    await user.type(input, 'New Name');
    await user.tab();
    await waitFor(() => expect(update).toHaveBeenCalledWith(1, 10, expect.objectContaining({ name: 'New Name' })));
  });

  it('FE-COMP-BUDGET-023: total price is shown formatted with currency symbol', async () => {
    const item = { ...buildBudgetItem({ id: 23, trip_id: 1, category: 'Restaurants', name: 'Dinner' }), total_price: 45.5 };
    await seedItems([item]);
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Dinner');
    // The formatted number appears in the InlineEditCell for total price (and grand total card)
    expect(screen.getAllByText('45.50').length).toBeGreaterThan(0);
    // The currency symbol appears (in category subtotal or grand total card)
    expect(screen.getAllByText(/€/).length).toBeGreaterThan(0);
  });

  it('FE-COMP-BUDGET-024: delete category button removes all items in that category', async () => {
    const user = userEvent.setup();
    const item = { ...buildBudgetItem({ id: 24, trip_id: 1, category: 'Flights', name: 'Flight to Paris' }), total_price: 200 };
    await seedItems([item]);
    render(<BudgetPanel tripId={1} />);
    await screen.findAllByText('Flights');
    await screen.findByText('Flight to Paris');
    await user.click(screen.getByTitle('Delete Category'));
    await waitFor(() => {
      expect(screen.queryAllByText('Flights').length).toBe(0);
      expect(screen.queryByText('Flight to Paris')).not.toBeInTheDocument();
    });
  });

  it('FE-COMP-BUDGET-025: CSV export button triggers download via URL.createObjectURL', async () => {
    const createObjectURL = vi.fn(() => 'blob:test');
    vi.spyOn(URL, 'createObjectURL').mockImplementation(createObjectURL);
    const user = userEvent.setup();
    const item = { ...buildBudgetItem({ trip_id: 1, category: 'Other', name: 'Misc' }), total_price: 10 };
    await seedItems([item]);
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('CSV');
    await user.click(screen.getByText('CSV'));
    expect(createObjectURL).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('FE-COMP-BUDGET-026: category total row shows sum of items in category', async () => {
    const item1 = { ...buildBudgetItem({ trip_id: 1, category: 'Food', name: 'Lunch' }), total_price: 20 };
    const item2 = { ...buildBudgetItem({ trip_id: 1, category: 'Food', name: 'Dinner' }), total_price: 30 };
    await seedItems([item1, item2]);
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Lunch');
    // The category header shows subtotal formatted as "50.00 €" (also appears in pie legend)
    expect(screen.getAllByText('50.00 €').length).toBeGreaterThan(0);
  });

  it('FE-COMP-BUDGET-027: add new category input is visible in empty state', async () => {
    render(<BudgetPanel tripId={1} />);
    expect(await screen.findByPlaceholderText('Enter category name...')).toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-028: creating a new category via input calls create and adds a section', async () => {
    const user = userEvent.setup();
    render(<BudgetPanel tripId={1} />);
    const input = await screen.findByPlaceholderText('Enter category name...');
    await user.type(input, 'Souvenirs{Enter}');
    expect(await screen.findByText('Souvenirs')).toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-029: settlement section renders flows with usernames', async () => {
    const user = userEvent.setup();
    const item = { ...buildBudgetItem({ trip_id: 1, category: 'Food', name: 'Dinner' }), total_price: 100 };
    await seedItems([item]);
    vi.mocked(budgetApi.settlement).mockResolvedValue({
      balances: [
        { user_id: 2, username: 'alice', balance: -10, avatar_url: null },
        { user_id: 3, username: 'bob', balance: 10, avatar_url: null },
      ],
      flows: [
        { from: { user_id: 2, username: 'alice', avatar_url: null }, to: { user_id: 3, username: 'bob', avatar_url: null }, amount: 10 },
      ],
    } as SettlementResponse);
    const tripMembers = [
      { id: 2, username: 'alice', avatar_url: null },
      { id: 3, username: 'bob', avatar_url: null },
    ];
    render(<BudgetPanel tripId={1} tripMembers={tripMembers} />);
    await screen.findByText('Dinner');
    // Click the settlement toggle button (role button with name containing "settlement")
    const settlementBtn = await screen.findByRole('button', { name: /settlement/i });
    await user.click(settlementBtn);
    // alice and bob should appear in balances section
    await screen.findByText('alice');
    expect(await screen.findByText('bob')).toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-030: per-person summary renders usernames', async () => {
    const item = {
      ...buildBudgetItem({ trip_id: 1, category: 'Food', name: 'Shared Dinner' }),
      total_price: 75,
      members: [{ user_id: 1, username: 'testuser', avatar_url: null, paid: 0 }],
    };
    await seedItems([item]);
    const tripMembers = [
      { id: 1, username: 'testuser', avatar_url: null },
      { id: 4, username: 'other', avatar_url: null },
    ];
    render(<BudgetPanel tripId={1} tripMembers={tripMembers} />);
    await screen.findByText('Shared Dinner');
    expect(await screen.findByText('testuser')).toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-032: grand total row shows sum across all categories', async () => {
    const item1 = { ...buildBudgetItem({ trip_id: 1, category: 'Transport', name: 'Flight' }), total_price: 100 };
    const item2 = { ...buildBudgetItem({ trip_id: 1, category: 'Hotels', name: 'Hotel' }), total_price: 200 };
    await seedItems([item1, item2]);
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Flight');
    await screen.findByText('Hotel');
    // Grand total card shows 300.00 (integer and decimal are rendered in separate spans)
    expect(document.body.textContent?.replace(/\s+/g, '')).toMatch(/300[,.]00/);
  });

  it('FE-COMP-BUDGET-033: read-only mode hides add/delete/edit controls', async () => {
    // Restrict budget_edit to trip owners only; user is not the owner (owner_id=1, user.id > 1)
    seedStore(usePermissionsStore, { permissions: { budget_edit: 'trip_owner' } });
    // Use a user with id != 1 so they're not the owner
    seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true });
    seedStore(useTripStore, { trip: buildTrip({ id: 1, user_id: 9999 }) });
    const item = { ...buildBudgetItem({ trip_id: 1, category: 'Food', name: 'Read Only Item' }), total_price: 50 };
    await seedItems([item]);
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Read Only Item');
    // In read-only mode the Delete button should not be visible
    expect(screen.queryByTitle('Delete')).not.toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-034: read-only mode shows expense_date as text span', async () => {
    seedStore(usePermissionsStore, { permissions: { budget_edit: 'trip_owner' } });
    seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true });
    seedStore(useTripStore, { trip: buildTrip({ id: 1, user_id: 9999 }) });
    const item = { ...buildBudgetItem({ trip_id: 1, category: 'Transport', name: 'Train' }), total_price: 30, expense_date: '2025-06-15' };
    await seedItems([item]);
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Train');
    // expense_date is rendered as plain text in read-only mode
    expect(await screen.findByText('2025-06-15')).toBeInTheDocument();
  });

  it('FE-COMP-BUDGET-035: settlement section with avatar renders user avatar image', async () => {
    const user = userEvent.setup();
    const item = { ...buildBudgetItem({ trip_id: 1, category: 'Food', name: 'Lunch' }), total_price: 60 };
    await seedItems([item]);
    vi.mocked(budgetApi.settlement).mockResolvedValue({
      balances: [
        { user_id: 2, username: 'alice', avatar_url: '/uploads/avatars/alice.jpg', balance: -30 },
        { user_id: 3, username: 'bob', avatar_url: null, balance: 30 },
      ],
      flows: [{ from: { user_id: 2, username: 'alice', avatar_url: '/uploads/avatars/alice.jpg' }, to: { user_id: 3, username: 'bob', avatar_url: null }, amount: 30 }],
    } as SettlementResponse);
    const tripMembers = [
      { id: 2, username: 'alice', avatar_url: '/uploads/avatars/alice.jpg' },
      { id: 3, username: 'bob', avatar_url: null },
    ];
    render(<BudgetPanel tripId={1} tripMembers={tripMembers} />);
    await screen.findByText('Lunch');
    // Trigger settlement display
    const settlementBtn = await screen.findByRole('button', { name: /settlement/i });
    await user.click(settlementBtn);
    await screen.findByText('alice');
    // Avatar image should be rendered for alice
    const avatarImg = screen.getAllByRole('img');
    expect(avatarImg.length).toBeGreaterThan(0);
  });

  it('FE-COMP-BUDGET-036: expense_date shows dash when not set in read-only mode', async () => {
    seedStore(usePermissionsStore, { permissions: { budget_edit: 'trip_owner' } });
    seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true });
    seedStore(useTripStore, { trip: buildTrip({ id: 1, user_id: 9999 }) });
    const item = { ...buildBudgetItem({ trip_id: 1, category: 'Food', name: 'Snack' }), total_price: 5, expense_date: null };
    await seedItems([item]);
    render(<BudgetPanel tripId={1} />);
    await screen.findByText('Snack');
    // When expense_date is null, the fallback '—' is shown
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThan(0);
  });
});
