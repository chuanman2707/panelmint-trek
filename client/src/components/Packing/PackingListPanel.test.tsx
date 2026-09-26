// FE-COMP-PACKING-001 to FE-COMP-PACKING-081
//
// The packing surface runs on the Dexie-backed local adapter — there is no
// HTTP layer to intercept. Mutation tests seed the rows they act on into
// `panelmintDb` and assert the persisted state (or the rendered result)
// instead of a request body. The hosted-only chrome is gone with it:
// bulk import, packing templates and the sharing/contributor actions.
import 'fake-indexeddb/auto';
import { vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '../../../tests/helpers/render';
import userEvent from '@testing-library/user-event';
import { useAuthStore } from '../../store/authStore';
import { useAddonStore } from '../../store/addonStore';
import { useTripStore } from '../../store/tripStore';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildUser, buildTrip, buildPackingItem } from '../../../tests/helpers/factories';
import PackingListPanel, { itemWeight } from './PackingListPanel';
import { db, type LocalTripMember } from '../../db/panelmintDb';
import type { PackingBag, PackingItem } from '../../types';

/** getMembers is local: a member is a trip_membership row (the roster falls
 *  back to the row's username when no localUsers entry exists). */
async function withMembers(members: { id: number; username: string }[]): Promise<void> {
  for (const m of members) {
    await db.tripMembers.put({
      tripId: 1, id: m.id, username: m.username, role: 'member',
      added_at: '2025-01-01T00:00:00.000Z', invited_by_username: 'owner', is_guest: false,
    } as LocalTripMember);
    await db.localUsers.put({ id: m.id, name: m.username, is_self: 0 });
  }
}

/** Item CRUD/clone runs on the packingItems table — seed the rows a mutation
 *  test acts on (the prop list drives the render, Dexie drives the write). */
async function seedItems(items: PackingItem[]): Promise<void> {
  await db.packingItems.bulkPut(items);
}

function buildBag(overrides: Partial<PackingBag> = {}): PackingBag {
  return {
    id: 1,
    trip_id: 1,
    name: 'Bag',
    color: '#6366f1',
    weight_limit_grams: null,
    sort_order: 0,
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('itemWeight (bag total weight calc)', () => {
  it('FE-COMP-PACKING-030: multiplies unit weight by quantity', () => {
    expect(itemWeight({ weight_grams: 120, quantity: 3 })).toBe(360);
  });
  it('FE-COMP-PACKING-031: defaults quantity to 1 when missing', () => {
    expect(itemWeight({ weight_grams: 250 })).toBe(250);
  });
  it('FE-COMP-PACKING-032: contributes 0 when weight is missing or zero', () => {
    expect(itemWeight({ quantity: 5 })).toBe(0);
    expect(itemWeight({ weight_grams: 0, quantity: 5 })).toBe(0);
    expect(itemWeight({})).toBe(0);
  });
});

beforeEach(async () => {
  resetAllStores();
  // The roster is Dexie now — owner 'owner' (self, id 1) on trip 1, no members.
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put({ id: 1, name: 'owner', is_self: 1 });
  await db.trips.put(buildTrip({ id: 1, user_id: 1 }));
  seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true });
  seedStore(useTripStore, { trip: buildTrip({ id: 1 }) });
});

describe('PackingListPanel', () => {
  it('FE-COMP-PACKING-001: renders Packing List title', () => {
    render(<PackingListPanel tripId={1} items={[]} />);
    expect(screen.getByText('Packing List')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-002: shows empty state when no items', () => {
    render(<PackingListPanel tripId={1} items={[]} />);
    // Both the subtitle and the empty content area say "Packing list is empty"
    const els = screen.getAllByText('Packing list is empty');
    expect(els.length).toBeGreaterThan(0);
  });

  it('FE-COMP-PACKING-003: empty state shows the packing mascot illustration', () => {
    const { container } = render(<PackingListPanel tripId={1} items={[]} />);
    // The reworded empty state drops the old hint copy in favour of the shared
    // EmptyState: the TREK mascot acting out the "packing" scene beside the title.
    expect(container.querySelector('.trek--packing')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-004: shows items from props grouped by category', () => {
    const items = [
      buildPackingItem({ name: 'Passport', category: 'Documents' }),
      buildPackingItem({ name: 'Charger', category: 'Electronics' }),
    ];
    render(<PackingListPanel tripId={1} items={items} />);
    expect(screen.getByText('Passport')).toBeInTheDocument();
    expect(screen.getByText('Charger')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-005: shows category group headers', () => {
    const items = [
      buildPackingItem({ name: 'Toothbrush', category: 'Hygiene' }),
    ];
    render(<PackingListPanel tripId={1} items={items} />);
    expect(screen.getByText('Hygiene')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-006: shows progress count in subtitle', () => {
    const items = [
      buildPackingItem({ name: 'Item1', checked: 1 }),
      buildPackingItem({ name: 'Item2', checked: 0 }),
    ];
    render(<PackingListPanel tripId={1} items={items} />);
    expect(screen.getByText(/1 of 2 packed/i)).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-007: shows progress bar for packed items', () => {
    const items = [
      buildPackingItem({ name: 'Item1', checked: 1 }),
    ];
    render(<PackingListPanel tripId={1} items={items} />);
    // 1/1 = 100% packed shows "All packed!"
    expect(screen.getByText('All packed!')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-008: items without category are grouped under default category', () => {
    const items = [
      buildPackingItem({ name: 'Sunscreen', category: null }),
    ];
    render(<PackingListPanel tripId={1} items={items} />);
    expect(screen.getByText('Sunscreen')).toBeInTheDocument();
    // default category is "Other"
    expect(screen.getByText('Other')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-009: clicking Add item reveals input form', async () => {
    const user = userEvent.setup();
    const items = [buildPackingItem({ name: 'Shorts', category: 'Clothing' })];
    render(<PackingListPanel tripId={1} items={items} />);
    // Click "Add item" button to reveal input
    await user.click(screen.getByText('Add item'));
    expect(screen.getByPlaceholderText('Item name...')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-010: typing in add item input and pressing Enter stores the item', async () => {
    const user = userEvent.setup();
    const existingItem = buildPackingItem({ name: 'Existing', category: 'Clothing' });
    render(<PackingListPanel tripId={1} items={[existingItem]} />);
    await user.click(screen.getByText('Add item'));
    const addInput = screen.getByPlaceholderText('Item name...');
    await user.type(addInput, 'T-Shirt{Enter}');
    await waitFor(async () => {
      const rows = await db.packingItems.toArray();
      expect(rows.some(r => r.name === 'T-Shirt' && r.category === 'Clothing')).toBe(true);
    });
  });

  it('FE-COMP-PACKING-011: checked item has checked state visually (1=checked)', () => {
    const items = [buildPackingItem({ name: 'Packed Item', checked: 1 })];
    render(<PackingListPanel tripId={1} items={items} />);
    expect(screen.getByText('Packed Item')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-012: unchecked item renders in open state', () => {
    const items = [buildPackingItem({ name: 'Unpacked Item', checked: 0 })];
    render(<PackingListPanel tripId={1} items={items} />);
    expect(screen.getByText('Unpacked Item')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-013: multiple categories render independently', () => {
    const items = [
      buildPackingItem({ name: 'Shirt', category: 'Clothing' }),
      buildPackingItem({ name: 'Passport', category: 'Documents' }),
    ];
    render(<PackingListPanel tripId={1} items={items} />);
    expect(screen.getByText('Clothing')).toBeInTheDocument();
    expect(screen.getByText('Documents')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-014: Add list button is shown', () => {
    render(<PackingListPanel tripId={1} items={[]} />);
    // The "Add list" button should be present in the toolbar
    expect(screen.getByText('Add list')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-015: clicking Add Category shows the category name input', async () => {
    const user = userEvent.setup();
    render(<PackingListPanel tripId={1} items={[]} />);
    await user.click(screen.getByText('Add list'));
    expect(await screen.findByPlaceholderText('List name (e.g. Clothing)')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-016: delete item button exists and removes the row', async () => {
    const user = userEvent.setup();
    // Uncategorized item: deleting it is a plain delete (a custom category's last
    // item is instead converted to a placeholder — see FE-COMP-PACKING-070).
    const item = buildPackingItem({ id: 99, name: 'To Remove', category: null });
    await seedItems([item]);
    render(<PackingListPanel tripId={1} items={[item]} />);
    expect(screen.getByText('To Remove')).toBeInTheDocument();
    // Delete button is in the DOM (opacity 0 on desktop but exists)
    const deleteBtn = screen.getByTitle('Delete');
    await user.click(deleteBtn);
    await waitFor(async () => {
      expect(await db.packingItems.get(99)).toBeUndefined();
    });
  });

  it('FE-COMP-PACKING-017: shows filter buttons (All, Open, Done) when items exist', () => {
    const items = [buildPackingItem({ name: 'Shirt', category: 'Clothing' })];
    render(<PackingListPanel tripId={1} items={items} />);
    expect(screen.getByText('All')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-018: filtering to Done hides unchecked items', async () => {
    const user = userEvent.setup();
    const items = [
      buildPackingItem({ name: 'Done Item', checked: 1, category: 'Test' }),
      buildPackingItem({ name: 'Open Item', checked: 0, category: 'Test' }),
    ];
    render(<PackingListPanel tripId={1} items={items} />);
    await user.click(screen.getByText('Done'));
    expect(screen.getByText('Done Item')).toBeInTheDocument();
    expect(screen.queryByText('Open Item')).not.toBeInTheDocument();
  });

  it('FE-COMP-PACKING-019: filtering to Open hides checked items', async () => {
    const user = userEvent.setup();
    const items = [
      buildPackingItem({ name: 'Done Item', checked: 1, category: 'Test' }),
      buildPackingItem({ name: 'Open Item', checked: 0, category: 'Test' }),
    ];
    render(<PackingListPanel tripId={1} items={items} />);
    await user.click(screen.getByText('Open'));
    expect(screen.queryByText('Done Item')).not.toBeInTheDocument();
    expect(screen.getByText('Open Item')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-020: renders empty filter message when filter yields nothing', async () => {
    const user = userEvent.setup();
    const items = [
      buildPackingItem({ name: 'Open Item', checked: 0, category: 'Test' }),
    ];
    render(<PackingListPanel tripId={1} items={items} />);
    await user.click(screen.getByText('Done'));
    expect(screen.getByText('No items match this filter')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-023: inline edit item name via pencil icon persists the rename', async () => {
    const user = userEvent.setup();
    const item = buildPackingItem({ id: 42, name: 'Sunscreen', category: 'Toiletries' });
    await seedItems([item]);
    render(<PackingListPanel tripId={1} items={[item]} />);

    // Click the rename (pencil) button
    await user.click(screen.getByTitle('Rename'));

    // Input appears pre-filled with 'Sunscreen'
    const input = screen.getByDisplayValue('Sunscreen');
    expect(input).toBeInTheDocument();

    // Clear and type new name, then press Enter
    await user.clear(input);
    await user.type(input, 'Sunblock');
    await user.keyboard('{Enter}');

    await waitFor(async () => {
      expect((await db.packingItems.get(42))!.name).toBe('Sunblock');
    });
  });

  it('FE-COMP-PACKING-024: toggle item checked state persists', async () => {
    const user = userEvent.setup();
    const item = buildPackingItem({ id: 50, name: 'Shorts', checked: 0, category: 'Clothing' });
    await seedItems([item]);
    const { container } = render(<PackingListPanel tripId={1} items={[item]} />);

    // The toggle button contains the Square icon for unchecked items
    const toggleBtn = container.querySelector('svg.lucide-square')?.closest('button');
    expect(toggleBtn).toBeTruthy();
    await user.click(toggleBtn!);

    await waitFor(async () => {
      expect((await db.packingItems.get(50))!.checked).toBe(1);
    });
  });

  it('FE-COMP-PACKING-025: "Check all" bulk action checks all unchecked items', async () => {
    const user = userEvent.setup();
    const item1 = buildPackingItem({ id: 60, name: 'Item1', checked: 0, category: 'TestCat' });
    const item2 = buildPackingItem({ id: 61, name: 'Item2', checked: 0, category: 'TestCat' });
    await seedItems([item1, item2]);
    const { container } = render(<PackingListPanel tripId={1} items={[item1, item2]} />);

    // Open the MoreHorizontal context menu
    const moreBtn = container.querySelector('svg.lucide-more-horizontal')?.closest('button');
    expect(moreBtn).toBeTruthy();
    await user.click(moreBtn!);

    // Click "Check All"
    await user.click(await screen.findByText('Check All'));

    await waitFor(async () => {
      expect((await db.packingItems.get(60))!.checked).toBe(1);
      expect((await db.packingItems.get(61))!.checked).toBe(1);
    });
  });

  it('FE-COMP-PACKING-026: quantity input change persists the new quantity', async () => {
    const user = userEvent.setup();
    const item = buildPackingItem({ id: 70, name: 'T-Shirts', quantity: 2, category: 'Clothing' });
    await seedItems([item]);
    render(<PackingListPanel tripId={1} items={[item]} />);

    // Find the quantity input showing '2'
    const qtyInput = screen.getByDisplayValue('2');
    await user.clear(qtyInput);
    await user.type(qtyInput, '5');
    await user.tab(); // blur triggers commit

    await waitFor(async () => {
      expect((await db.packingItems.get(70))!.quantity).toBe(5);
    });
  });

  it('FE-COMP-PACKING-027: add new category via form stores a row in it', async () => {
    const user = userEvent.setup();
    render(<PackingListPanel tripId={1} items={[]} />);

    await user.click(screen.getByText('Add list'));
    const input = await screen.findByPlaceholderText('List name (e.g. Clothing)');
    await user.type(input, 'Valuables');
    await user.keyboard('{Enter}');

    await waitFor(async () => {
      const rows = await db.packingItems.toArray();
      expect(rows.some(r => r.category === 'Valuables')).toBe(true);
    });
  });

  it('FE-COMP-PACKING-028: category group collapse hides items, expand shows them', async () => {
    const user = userEvent.setup();
    const item = buildPackingItem({ name: 'Sunscreen', category: 'Toiletries' });
    const { container } = render(<PackingListPanel tripId={1} items={[item]} />);

    // Item is visible initially
    expect(screen.getByText('Sunscreen')).toBeInTheDocument();

    // Click the ChevronDown button to collapse
    const chevronDown = container.querySelector('svg.lucide-chevron-down')?.closest('button');
    expect(chevronDown).toBeTruthy();
    await user.click(chevronDown!);

    // Item should no longer be visible
    expect(screen.queryByText('Sunscreen')).not.toBeInTheDocument();

    // Click the ChevronRight button to expand again
    const chevronRight = container.querySelector('svg.lucide-chevron-right')?.closest('button');
    expect(chevronRight).toBeTruthy();
    await user.click(chevronRight!);

    // Item visible again
    expect(screen.getByText('Sunscreen')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-029: bag tracking sidebar not shown when disabled', async () => {
    // bagTracking defaults on in the static addon store — turn it off here.
    seedStore(useAddonStore, { bagTracking: false });
    render(<PackingListPanel tripId={1} items={[buildPackingItem({ category: 'Test' })]} />);
    // No "Bags" heading or luggage sidebar should appear
    await waitFor(() => {
      expect(screen.queryByText('Bags')).not.toBeInTheDocument();
    });
  });

  it('FE-COMP-PACKING-031: "Uncheck All" bulk action unchecks checked items', async () => {
    const user = userEvent.setup();
    const item1 = buildPackingItem({ id: 80, name: 'ItemA', checked: 1, category: 'Gear' });
    const item2 = buildPackingItem({ id: 81, name: 'ItemB', checked: 1, category: 'Gear' });
    await seedItems([item1, item2]);
    const { container } = render(<PackingListPanel tripId={1} items={[item1, item2]} />);

    // Open the MoreHorizontal context menu
    const moreBtn = container.querySelector('svg.lucide-more-horizontal')?.closest('button');
    expect(moreBtn).toBeTruthy();
    await user.click(moreBtn!);

    // Click "Uncheck All"
    await user.click(await screen.findByText('Uncheck All'));

    await waitFor(async () => {
      expect((await db.packingItems.get(80))!.checked).toBe(0);
      expect((await db.packingItems.get(81))!.checked).toBe(0);
    });
  });

  it('FE-COMP-PACKING-032: category assignee button shown when trip members exist', async () => {
    await withMembers([{ id: 2, username: 'alice' }]);
    const item = buildPackingItem({ name: 'Passport', category: 'Documents' });
    const { container } = render(<PackingListPanel tripId={1} items={[item]} />);

    // UserPlus assignee button should appear in the category header
    await waitFor(() => {
      const userPlusBtn = container.querySelector('svg.lucide-user-plus');
      expect(userPlusBtn).toBeTruthy();
    });
  });

  it('FE-COMP-PACKING-034: bag tracking enabled shows Bags button and bag sidebar', async () => {
    await db.packingBags.put(buildBag({ id: 1, name: 'Carry-on' }));
    const items = [buildPackingItem({ name: 'Laptop', category: 'Electronics' })];
    render(<PackingListPanel tripId={1} items={items} />);

    // Bags button/sidebar appears when bag tracking is enabled
    await waitFor(() => {
      const bagsEls = screen.getAllByText('Bags');
      expect(bagsEls.length).toBeGreaterThan(0);
    });
  });

  it('FE-COMP-PACKING-035: category rename via context menu persists the new name', async () => {
    const user = userEvent.setup();
    const item = buildPackingItem({ id: 90, name: 'Shirt', category: 'Clothing' });
    await seedItems([item]);
    const { container } = render(<PackingListPanel tripId={1} items={[item]} />);

    // Open the category context menu
    const moreBtn = container.querySelector('svg.lucide-more-horizontal')?.closest('button');
    expect(moreBtn).toBeTruthy();
    await user.click(moreBtn!);

    // Click "Rename" in the menu
    await user.click(await screen.findByText('Rename'));

    // List name input appears — type new name and save
    const catInput = screen.getByDisplayValue('Clothing');
    await user.clear(catInput);
    await user.type(catInput, 'Apparel');
    await user.keyboard('{Enter}');

    await waitFor(async () => {
      expect((await db.packingItems.get(90))!.category).toBe('Apparel');
    });
  });

  it('FE-COMP-PACKING-036: assignee dropdown opens and lists members when clicked', async () => {
    await withMembers([{ id: 2, username: 'alice' }]);
    const item = buildPackingItem({ name: 'Camera', category: 'Electronics' });
    const { container } = render(<PackingListPanel tripId={1} items={[item]} />);

    // Wait for members to load, then click the UserPlus button
    await waitFor(() => {
      expect(container.querySelector('svg.lucide-user-plus')).toBeTruthy();
    });

    const userPlusBtn = container.querySelector('svg.lucide-user-plus')?.closest('button');
    await userEvent.setup().click(userPlusBtn!);

    // Member names appear in the dropdown
    await screen.findByText('owner');
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-039: bag modal opens when Bags button clicked with bag tracking enabled', async () => {
    const user = userEvent.setup();
    await db.packingBags.put(buildBag({ id: 1, name: 'Main Bag' }));
    const items = [buildPackingItem({ name: 'Charger', category: 'Electronics' })];
    const { container } = render(<PackingListPanel tripId={1} items={items} />);

    // Wait for Bags button to appear
    await waitFor(() => {
      expect(screen.getAllByText('Bags').length).toBeGreaterThan(0);
    });

    // Click the Bags button (xl:!hidden - visible in jsdom)
    const luggageBtn = container.querySelector('button svg.lucide-luggage')?.closest('button');
    expect(luggageBtn).toBeTruthy();
    await user.click(luggageBtn!);

    // Modal opens — "Main Bag" text appears (sidebar + modal — use getAllByText)
    await waitFor(() => {
      const bagTexts = screen.getAllByText('Main Bag');
      expect(bagTexts.length).toBeGreaterThan(0);
    });
  });

  it('FE-COMP-PACKING-040: bag sidebar renders BagCard with bag name when enabled and bags exist', async () => {
    await db.packingBags.put(buildBag({ id: 5, name: 'Backpack', color: '#10b981', weight_limit_grams: 10000 }));
    const items = [buildPackingItem({ name: 'Laptop', category: 'Tech' })];
    render(<PackingListPanel tripId={1} items={items} />);

    // BagCard in sidebar shows the bag name (may appear once or more with modal)
    await waitFor(() => {
      expect(screen.getAllByText('Backpack').length).toBeGreaterThan(0);
    });
  });

  it('FE-COMP-PACKING-044: bag item row shows weight input and bag button when bag tracking enabled', async () => {
    const items = [buildPackingItem({ name: 'Laptop', category: 'Tech' })];
    const { container } = render(<PackingListPanel tripId={1} items={items} />);

    // Wait for bag tracking to enable (weight input 'g' label appears)
    await waitFor(() => {
      expect(container.querySelector('input[placeholder="—"]')).toBeTruthy();
    });

    // The 'g' gram label appears next to the weight input
    expect(container.querySelector('span[style*="g"]')).toBeTruthy();
  });

  it('FE-COMP-PACKING-045: "Remove checked" button appears when checked items exist', async () => {
    const user = userEvent.setup();
    const items = [
      buildPackingItem({ name: 'Done1', checked: 1, category: 'Test' }),
      buildPackingItem({ name: 'Done2', checked: 1, category: 'Test' }),
    ];
    await seedItems(items);
    // Mock window.confirm to return true
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<PackingListPanel tripId={1} items={items} />);

    // The "Remove N checked" button should be visible (two spans exist - one sm:hidden, one hidden sm:inline)
    const removeBtns = screen.getAllByText(/Remove 2/);
    expect(removeBtns.length).toBeGreaterThan(0);

    // Click the parent button (either span's closest button)
    const removeBtn = removeBtns[0].closest('button')!;
    expect(removeBtn).toBeTruthy();
    await user.click(removeBtn);
    // confirm was called
    expect(window.confirm).toHaveBeenCalled();
    // and the checked rows are gone from Dexie
    await waitFor(async () => {
      expect(await db.packingItems.toArray()).toHaveLength(0);
    });

    vi.restoreAllMocks();
  });

  it('FE-COMP-PACKING-047: bag picker in item row opens when clicked with bag tracking enabled', async () => {
    const user = userEvent.setup();
    await db.packingBags.put(buildBag({ id: 3, name: 'Carry-on', color: '#ec4899' }));
    const items = [buildPackingItem({ name: 'Laptop', category: 'Tech' })];
    const { container } = render(<PackingListPanel tripId={1} items={items} />);

    // Wait for bag tracking to enable (Package icon button in item row)
    await waitFor(() => {
      expect(container.querySelector('svg.lucide-package')).toBeTruthy();
    });

    // Click the bag button (Package icon) to open bag picker
    const packageBtn = container.querySelector('svg.lucide-package')?.closest('button');
    expect(packageBtn).toBeTruthy();
    await user.click(packageBtn!);

    // Bag picker dropdown shows the bag name (may also appear in sidebar)
    await waitFor(() => {
      expect(screen.getAllByText('Carry-on').length).toBeGreaterThan(0);
    });
  });

  it('FE-COMP-PACKING-048: add bag in bag modal opens form when "Add bag" clicked', async () => {
    const user = userEvent.setup();
    await db.packingBags.put(buildBag({ id: 1, name: 'Main Bag' }));
    const items = [buildPackingItem({ name: 'Jacket', category: 'Clothing' })];
    const { container } = render(<PackingListPanel tripId={1} items={items} />);

    // Wait for Bags button
    await waitFor(() => {
      expect(screen.getAllByText('Bags').length).toBeGreaterThan(0);
    });

    // Open bag modal
    const luggageBtn = container.querySelector('button svg.lucide-luggage')?.closest('button');
    await user.click(luggageBtn!);

    // Wait for modal to show ("Add bag" button appears — may be in both sidebar and modal)
    await waitFor(() => {
      expect(screen.getAllByText('Add bag').length).toBeGreaterThan(0);
    });

    // Click the last "Add bag" (in the modal)
    const addBagBtns = screen.getAllByText('Add bag');
    await user.click(addBagBtns[addBagBtns.length - 1]);

    // Add bag name input appears (may exist in both sidebar and modal)
    await waitFor(() => {
      const bagInputs = screen.queryAllByPlaceholderText('Bag name...');
      expect(bagInputs.length).toBeGreaterThan(0);
    });
  });

  it('FE-COMP-PACKING-049: weight input change persists weight_grams', async () => {
    const itemId = 120;
    const items = [buildPackingItem({ id: itemId, name: 'Camera', category: 'Electronics' })];
    await seedItems(items);
    const { container } = render(<PackingListPanel tripId={1} items={items} />);

    // Wait for weight input to appear (bag tracking enabled)
    await waitFor(() => {
      expect(container.querySelector('input[placeholder="—"]')).toBeTruthy();
    });

    // The NumericInput commits on every change event — one change, one write.
    const weightInput = container.querySelector('input[placeholder="—"]') as HTMLInputElement;
    fireEvent.change(weightInput, { target: { value: '500' } });

    await waitFor(async () => {
      expect((await db.packingItems.get(itemId))!.weight_grams).toBe(500);
    });
  });

  it('FE-COMP-PACKING-050: ArtikelZeile category change picker opens on dot button click', async () => {
    const user = userEvent.setup();
    const item = buildPackingItem({ name: 'Camera', category: 'Electronics' });
    const item2 = buildPackingItem({ name: 'Passport', category: 'Documents' });
    render(<PackingListPanel tripId={1} items={[item, item2]} />);

    // The category change picker is triggered by a small dot button (no title)
    // It's rendered inside the action buttons group (sm:opacity-0 sm:group-hover:opacity-100)
    // In jsdom, CSS classes don't apply so the buttons are accessible
    // Find all buttons with the 'Move to List' title
    const catChangeBtn = screen.getAllByTitle('Move to List');
    expect(catChangeBtn.length).toBeGreaterThan(0);
    await user.click(catChangeBtn[0]);

    // Category picker shows both category names
    await waitFor(() => {
      expect(screen.getAllByText('Electronics').length).toBeGreaterThan(0);
    });
  });

  it('FE-COMP-PACKING-051: bag assignment from picker persists bag_id', async () => {
    const user = userEvent.setup();
    const itemId = 130;
    await db.packingBags.put(buildBag({ id: 7, name: 'Trolley', color: '#10b981' }));
    const items = [buildPackingItem({ id: itemId, name: 'Shoes', category: 'Clothing' })];
    await seedItems(items);
    const { container } = render(<PackingListPanel tripId={1} items={items} />);

    // Wait for bag tracking to enable (Package icon appears)
    await waitFor(() => {
      expect(container.querySelector('svg.lucide-package')).toBeTruthy();
    });

    // Use fireEvent (no pointer events) to open the picker without triggering mouseLeave
    const packageBtn = container.querySelector('svg.lucide-package')?.closest('button');
    fireEvent.click(packageBtn!);

    // Picker is open - find "Trolley" button inside the dropdown. The bag
    // sidebar carries the same name on its own button, so scope the query to
    // the picker (the dropdown is a sibling of the package button).
    const trolleyBtn = await within(packageBtn!.parentElement!).findByRole('button', { name: /Trolley/ });
    fireEvent.click(trolleyBtn);

    await waitFor(async () => {
      expect((await db.packingItems.get(itemId))!.bag_id).toBe(7);
    });
  });

  it('FE-COMP-PACKING-052: category assignee chip renders when assignees exist', async () => {
    await withMembers([{ id: 2, username: 'alice' }]);
    await db.packingCategoryAssignees.put({
      id: 1, trip_id: 1, category_name: 'Electronics', user_id: 2,
    });
    const item = buildPackingItem({ name: 'Camera', category: 'Electronics' });
    render(<PackingListPanel tripId={1} items={[item]} />);

    // The assignee chip shows the first letter of username
    await waitFor(() => {
      const chips = document.querySelectorAll('.assignee-chip');
      expect(chips.length).toBeGreaterThan(0);
    });
  });

  it('FE-COMP-PACKING-054: item with assigned bag shows the bag dot instead of the Package icon', async () => {
    const itemId = 140;
    await db.packingBags.put(buildBag({ id: 5, name: 'MyBag', color: '#ec4899' }));
    // Item that already has a bag assigned
    const items = [buildPackingItem({ id: itemId, name: 'Jacket', category: 'Clothing', bag_id: 5 })];
    const { container } = render(<PackingListPanel tripId={1} items={items} />);

    // Wait for bag tracking to enable
    await waitFor(() => {
      // When bag_id is set, the bag button shows a colored dot (not Package icon)
      expect(container.querySelector('svg.lucide-package')).toBeFalsy();
    });

    // Verify the bags section renders in sidebar
    await screen.findByText('MyBag');
  });

  it('FE-COMP-PACKING-037: delete category via context menu removes all its items', async () => {
    const user = userEvent.setup();
    const item1 = buildPackingItem({ id: 100, name: 'Rope', category: 'Gear' });
    const item2 = buildPackingItem({ id: 101, name: 'Map', category: 'Gear' });
    await seedItems([item1, item2]);
    const { container } = render(<PackingListPanel tripId={1} items={[item1, item2]} />);

    // Open context menu and click Delete List
    const moreBtn = container.querySelector('svg.lucide-more-horizontal')?.closest('button');
    await user.click(moreBtn!);
    await user.click(await screen.findByText('Delete List'));

    await waitFor(async () => {
      expect(await db.packingItems.get(100)).toBeUndefined();
      expect(await db.packingItems.get(101)).toBeUndefined();
    });
  });

  it('FE-COMP-PACKING-056: pressing Enter in quantity input commits value', async () => {
    const user = userEvent.setup();
    const item = buildPackingItem({ id: 71, name: 'Socks', quantity: 3, category: 'Clothing' });
    await seedItems([item]);
    render(<PackingListPanel tripId={1} items={[item]} />);

    const qtyInput = screen.getByDisplayValue('3');
    await user.clear(qtyInput);
    await user.type(qtyInput, '7');
    await user.keyboard('{Enter}');

    await waitFor(async () => {
      expect((await db.packingItems.get(71))!.quantity).toBe(7);
    });
  });

  it('FE-COMP-PACKING-057: clicking unchecked item name enters inline edit mode', async () => {
    const user = userEvent.setup();
    const item = buildPackingItem({ id: 73, name: 'Jacket', checked: 0, category: 'Clothing' });
    render(<PackingListPanel tripId={1} items={[item]} />);

    // Click the item name span (not the Rename button — the name span itself)
    const nameSpan = screen.getByText('Jacket');
    await user.click(nameSpan);

    // An edit input should appear with the item's name pre-filled
    await waitFor(() => {
      const input = screen.getByDisplayValue('Jacket');
      expect(input.tagName).toBe('INPUT');
    });
  });

  it('FE-COMP-PACKING-058: selecting a different category in picker persists the category', async () => {
    const itemA = buildPackingItem({ id: 74, name: 'Camera', category: 'Electronics' });
    const itemB = buildPackingItem({ id: 75, name: 'Passport', category: 'Documents' });
    await seedItems([itemA, itemB]);
    render(<PackingListPanel tripId={1} items={[itemA, itemB]} />);

    // Use fireEvent (no pointer events) to open the category picker — avoids mouseLeave closing picker
    const catChangeBtns = screen.getAllByTitle('Move to List');
    fireEvent.click(catChangeBtns[0]);

    // Picker shows available categories — find and click the 'Documents' button (role=button, text=Documents)
    const docBtn = await screen.findByRole('button', { name: 'Documents' });
    fireEvent.click(docBtn);

    await waitFor(async () => {
      expect((await db.packingItems.get(74))!.category).toBe('Documents');
    });
  });

  it('FE-COMP-PACKING-059: clicking member in UserPlus dropdown stores the category assignee', async () => {
    await withMembers([{ id: 2, username: 'alice' }]);
    const item = buildPackingItem({ name: 'Tripod', category: 'Electronics' });
    const { container } = render(<PackingListPanel tripId={1} items={[item]} />);

    // Wait for members to load
    await waitFor(() => expect(container.querySelector('svg.lucide-user-plus')).toBeTruthy());

    // Click UserPlus to open assignee dropdown
    const userPlusBtn = container.querySelector('svg.lucide-user-plus')?.closest('button');
    await userEvent.setup().click(userPlusBtn!);

    // Click member 'alice' in dropdown
    const aliceBtn = await screen.findByRole('button', { name: /alice/i });
    await userEvent.setup().click(aliceBtn);

    await waitFor(async () => {
      const rows = await db.packingCategoryAssignees.toArray();
      expect(rows).toEqual([
        expect.objectContaining({ trip_id: 1, category_name: 'Electronics', user_id: 2 }),
      ]);
    });
  });

  it('FE-COMP-PACKING-060: clicking assignee chip removes the assignee row', async () => {
    await withMembers([{ id: 2, username: 'alice' }]);
    await db.packingCategoryAssignees.put({
      id: 1, trip_id: 1, category_name: 'Electronics', user_id: 2,
    });
    const item = buildPackingItem({ name: 'Camera', category: 'Electronics' });
    render(<PackingListPanel tripId={1} items={[item]} />);

    // Wait for the assignee chip to appear
    await waitFor(() => expect(document.querySelectorAll('.assignee-chip').length).toBeGreaterThan(0));

    // Click the chip wrapper div to remove the assignee
    const chip = document.querySelector('.assignee-chip')!.parentElement!;
    fireEvent.click(chip);

    await waitFor(async () => {
      expect(await db.packingCategoryAssignees.toArray()).toEqual([]);
    });
  });

  it('FE-COMP-PACKING-063: creating a bag via sidebar form stores the bag', async () => {
    const user = userEvent.setup();
    // Start with one bag so the sidebar renders (sidebar requires bags.length > 0)
    await db.packingBags.put(buildBag({ id: 1, name: 'Existing Bag' }));
    const items = [buildPackingItem({ name: 'Boots', category: 'Clothing' })];
    render(<PackingListPanel tripId={1} items={items} />);

    // Wait for sidebar "Add bag" button (sidebar renders when bags.length > 0)
    await waitFor(() => expect(screen.getAllByText('Add bag').length).toBeGreaterThan(0));
    const addBagBtns = screen.getAllByText('Add bag');
    await user.click(addBagBtns[0]);

    // Bag name input appears
    const bagInput = await screen.findByPlaceholderText('Bag name...');
    await user.type(bagInput, 'Hiking Pack');
    await user.keyboard('{Enter}');

    await waitFor(async () => {
      const bags = await db.packingBags.toArray();
      expect(bags.some(b => b.name === 'Hiking Pack')).toBe(true);
    });
  });

  it('FE-COMP-PACKING-064: deleting a bag from sidebar removes it', async () => {
    const user = userEvent.setup();
    await db.packingBags.put(buildBag({ id: 9, name: 'Old Bag' }));
    const items = [buildPackingItem({ name: 'Shirt', category: 'Clothing' })];
    const { container } = render(<PackingListPanel tripId={1} items={items} />);

    // Wait for bag to appear in sidebar
    await waitFor(() => expect(screen.getAllByText('Old Bag').length).toBeGreaterThan(0));

    // Click the X (delete) button on the BagCard in the sidebar
    const xBtns = container.querySelectorAll('svg.lucide-x');
    expect(xBtns.length).toBeGreaterThan(0);
    await user.click(xBtns[0].closest('button')!);

    await waitFor(async () => {
      expect(await db.packingBags.get(9)).toBeUndefined();
    });
  });

  it('FE-COMP-PACKING-065: clicking bag name in sidebar enters edit mode and saves', async () => {
    const user = userEvent.setup();
    await db.packingBags.put(buildBag({ id: 11, name: 'Carry-on', color: '#10b981' }));
    const items = [buildPackingItem({ name: 'Shoes', category: 'Clothing' })];
    render(<PackingListPanel tripId={1} items={items} />);

    // Wait for bag name in sidebar
    await waitFor(() => expect(screen.getAllByText('Carry-on').length).toBeGreaterThan(0));

    // Click the bag name span to enter edit mode
    const bagNameSpans = screen.getAllByText('Carry-on');
    await user.click(bagNameSpans[0]);

    // An edit input should appear
    const bagNameInput = await screen.findByDisplayValue('Carry-on');
    await user.clear(bagNameInput);
    await user.type(bagNameInput, 'Luggage');
    await user.keyboard('{Enter}');

    await waitFor(async () => {
      expect((await db.packingBags.get(11))!.name).toBe('Luggage');
    });
  });

  // #207: the column, the contract and the API have existed since v2.9.0 — there was
  // simply no way to type a limit in, so users encoded it in the bag name instead.
  it('FE-COMP-PACKING-065b: a bag without a limit offers to set one, in kg', async () => {
    const user = userEvent.setup();
    await db.packingBags.put(buildBag({ id: 12, name: 'Cabin bag', color: '#10b981' }));
    render(<PackingListPanel tripId={1} items={[buildPackingItem({ name: 'Jacket', category: 'Clothing' })]} />);

    await waitFor(() => expect(screen.getAllByText('Set limit').length).toBeGreaterThan(0));
    await user.click(screen.getAllByText('Set limit')[0]);

    const limitInput = await screen.findByLabelText('Weight limit');
    await user.type(limitInput, '8');
    await user.keyboard('{Enter}');

    // Entered in kilograms, stored in grams.
    await waitFor(async () => {
      expect((await db.packingBags.get(12))!.weight_limit_grams).toBe(8000);
    });
  });

  it('FE-COMP-PACKING-065c: an existing limit is shown next to the packed weight and can be cleared', async () => {
    const user = userEvent.setup();
    await db.packingBags.put(buildBag({ id: 13, name: 'Hold bag', weight_limit_grams: 20000 }));
    render(<PackingListPanel tripId={1} items={[buildPackingItem({ name: 'Boots', category: 'Clothing' })]} />);

    await waitFor(() => expect(screen.getAllByText(/\/ 20\.0 kg/).length).toBeGreaterThan(0));

    await user.click(screen.getAllByText(/\/ 20\.0 kg/)[0]);
    const limitInput = await screen.findByLabelText('Weight limit');
    await user.clear(limitInput);
    await user.keyboard('{Enter}');

    // An emptied field clears the limit rather than writing 0.
    await waitFor(async () => {
      expect((await db.packingBags.get(13))!.weight_limit_grams).toBeNull();
    });
  });

  it('FE-COMP-PACKING-066: BagCard Plus button opens user picker with trip members', async () => {
    const user = userEvent.setup();
    await withMembers([{ id: 2, username: 'bob' }]);
    await db.packingBags.put(buildBag({ id: 12, name: 'Day Pack', color: '#ec4899' }));
    const items = [buildPackingItem({ name: 'Camera', category: 'Electronics' })];
    const { container } = render(<PackingListPanel tripId={1} items={items} />);

    // Wait for the BagCard to render in the sidebar
    await waitFor(() => {
      expect(screen.getAllByText('Day Pack').length).toBeGreaterThan(0);
    });

    // Wait for tripMembers to load — UserPlus icon appears in category header when members exist
    await waitFor(() => {
      expect(container.querySelector('svg.lucide-user-plus')).toBeTruthy();
    });

    // Find BagCard Plus button by navigating from the bag name span:
    // bag name <span> → header row <div> → outer BagCard <div> → querySelector for dashed button
    const bagNameEl = screen.getAllByText('Day Pack')[0];
    const bagCardOuter = bagNameEl.parentElement!.parentElement!;
    const bagCardPlusBtn = bagCardOuter.querySelector('button[style*="dashed"]') as HTMLElement;
    expect(bagCardPlusBtn).toBeTruthy();
    await user.click(bagCardPlusBtn);

    // User picker dropdown appears with member names (tripMembers already loaded)
    await screen.findByText('bob');
    expect(screen.getByText('owner')).toBeInTheDocument();
  });

  it('FE-COMP-PACKING-067: BagCard user picker member click stores the bag member', async () => {
    await withMembers([{ id: 3, username: 'carol' }]);
    await db.packingBags.put(buildBag({ id: 13, name: 'Weekend Bag', color: '#f97316' }));
    const items = [buildPackingItem({ name: 'Laptop', category: 'Tech' })];
    const { container } = render(<PackingListPanel tripId={1} items={items} />);

    // Wait for the BagCard to render and tripMembers to load
    await waitFor(() => {
      expect(screen.getAllByText('Weekend Bag').length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(container.querySelector('svg.lucide-user-plus')).toBeTruthy();
    });

    // Find BagCard Plus button within the BagCard's DOM subtree:
    // bag name <span> → header row <div> → outer BagCard <div> → find dashed button
    const bagNameEl = screen.getAllByText('Weekend Bag')[0];
    const bagCardOuter = bagNameEl.parentElement!.parentElement!;
    const bagCardPlusBtn = bagCardOuter.querySelector('button[style*="dashed"]') as HTMLElement;
    expect(bagCardPlusBtn).toBeTruthy();
    fireEvent.click(bagCardPlusBtn);

    // Click 'carol' in the picker (accessible name: "C carol" from avatar initial + username)
    const carolBtn = await screen.findByText('carol');
    fireEvent.click(carolBtn.closest('button')!);

    await waitFor(async () => {
      const rows = await db.packingBagMembers.toArray();
      expect(rows).toEqual([expect.objectContaining({ bag_id: 13, user_id: 3 })]);
    });
  });

  it('FE-COMP-PACKING-068: inline bag create in item row picker creates bag and assigns it', async () => {
    const item = buildPackingItem({ id: 150, name: 'Sunglasses', category: 'Accessories' });
    await seedItems([item]);
    const { container } = render(<PackingListPanel tripId={1} items={[item]} />);

    // Wait for Package icon (bag button in item row)
    await waitFor(() => expect(container.querySelector('svg.lucide-package')).toBeTruthy());

    // Use fireEvent to open picker (avoids mouseLeave pointer events)
    const packageBtn = container.querySelector('svg.lucide-package')?.closest('button');
    fireEvent.click(packageBtn!);

    // Click "Add bag" inside picker to show inline create
    const addBagInPickerBtns = await screen.findAllByText('Add bag');
    fireEvent.click(addBagInPickerBtns[addBagInPickerBtns.length - 1]);

    // Inline input appears in picker
    const inlineInput = await screen.findByPlaceholderText('Bag name...');
    fireEvent.change(inlineInput, { target: { value: 'New Bag' } });
    fireEvent.keyDown(inlineInput, { key: 'Enter' });

    await waitFor(async () => {
      const bag = (await db.packingBags.toArray()).find(b => b.name === 'New Bag');
      expect(bag).toBeTruthy();
      expect((await db.packingItems.get(150))!.bag_id).toBe(bag!.id);
    });
  });

  it('FE-COMP-PACKING-070: deleting the last item of a custom category converts the row to a placeholder so the category persists in place (#1289)', async () => {
    const user = userEvent.setup();
    const item = buildPackingItem({ id: 99, name: 'Tent', category: 'Camping Gear' });
    // handleDeleteItem decides "last in category" from the rendered list.
    seedStore(useTripStore, { packingItems: [item] });
    await seedItems([item]);
    render(<PackingListPanel tripId={1} items={[item]} />);

    await user.click(screen.getByTitle('Delete'));

    // The row is updated in place (same id) rather than deleted, so colour/position hold.
    await waitFor(async () => {
      expect((await db.packingItems.get(99))!.name).toBe('...');
    });
    expect(await db.packingItems.get(99)).toBeTruthy();
  });

  it('FE-COMP-PACKING-071: deleting the placeholder row deletes it, dismissing the empty category (#1289)', async () => {
    const user = userEvent.setup();
    const placeholder = buildPackingItem({ id: 5, name: '...', category: 'Camping Gear' });
    seedStore(useTripStore, { packingItems: [placeholder] });
    await seedItems([placeholder]);
    render(<PackingListPanel tripId={1} items={[placeholder]} />);

    await user.click(screen.getByTitle('Delete'));

    // It is the placeholder itself — it must be removed, not re-converted.
    await waitFor(async () => {
      expect(await db.packingItems.get(5)).toBeUndefined();
    });
  });

  it('FE-COMP-PACKING-072: adding an item to an empty category reuses the placeholder row instead of appending (#1289)', async () => {
    const user = userEvent.setup();
    const placeholder = buildPackingItem({ id: 5, name: '...', category: 'Camping Gear' });
    seedStore(useTripStore, { packingItems: [placeholder] });
    await seedItems([placeholder]);
    render(<PackingListPanel tripId={1} items={[placeholder]} />);

    // Open the category's inline "Add item" and add a real entry.
    await user.click(screen.getByText('Add item'));
    const input = await screen.findByPlaceholderText('Item name...');
    await user.type(input, 'Tent');
    await user.keyboard('{Enter}');

    // The placeholder row is updated in place — no new row is created.
    await waitFor(async () => {
      expect((await db.packingItems.get(5))!.name).toBe('Tent');
    });
    expect(await db.packingItems.toArray()).toHaveLength(1);
  });

  // ── Three-tier sharing (#858) ──────────────────────────────────────────────
  it('FE-COMP-PACKING-080: the view switch separates the Common pool from My list', async () => {
    seedStore(useAuthStore, { user: buildUser({ id: 1 }), isAuthenticated: true });
    const items = [
      buildPackingItem({ name: 'Group tent', is_private: 0 }),
      buildPackingItem({ name: 'My diary', is_private: 1, owner_id: 1 }),
    ];
    render(<PackingListPanel tripId={1} items={items} />);

    // Default view = Common pool → only the shared item.
    expect(await screen.findByText('Group tent')).toBeInTheDocument();
    expect(screen.queryByText('My diary')).not.toBeInTheDocument();

    // Switch to "My list" → only the personal item.
    await userEvent.click(screen.getByText('My list'));
    expect(await screen.findByText('My diary')).toBeInTheDocument();
    expect(screen.queryByText('Group tent')).not.toBeInTheDocument();
  });

  it('FE-COMP-PACKING-081: a shared-to-me item lists in My list without a bringer badge', async () => {
    seedStore(useAuthStore, { user: buildUser({ id: 1 }), isAuthenticated: true });
    const items = [
      buildPackingItem({ name: 'Power bank', is_private: 1, owner_id: 2, owner_username: 'Bob', recipients: [{ user_id: 1, username: 'me' }] }),
    ];
    render(<PackingListPanel tripId={1} items={items} />);
    await userEvent.click(screen.getByText('My list'));
    // The item stays visible — it just no longer narrates who covers it
    // (the "by Bob" badge went away with the hosted sharing chrome).
    await screen.findByText('Power bank');
    expect(screen.queryByText('by Bob')).not.toBeInTheDocument();
  });
});
