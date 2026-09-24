// FE-COMP-MBOTTOMNAV-001 — the collections/journey/vacay "+" routes went with the hosted screens.

const mockNavigate = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { render, screen } from '../../../tests/helpers/render';
import userEvent from '@testing-library/user-event';
import { useAuthStore } from '../../store/authStore';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildUser } from '../../../tests/helpers/factories';
import MBottomNav from './MBottomNav';

const currentUser = buildUser({ id: 1, username: 'testuser', email: 'test@example.com' });

beforeEach(() => {
  resetAllStores();
  mockNavigate.mockClear();
  sessionStorage.clear();
  seedStore(useAuthStore, { user: currentUser, isAuthenticated: true });
});

describe('MBottomNav', () => {
  it('FE-COMP-MBOTTOMNAV-001: the dock "+" creates a trip on an unclaimed route', async () => {
    const user = userEvent.setup();
    render(<MBottomNav />, { initialEntries: ['/dashboard'] });
    await user.click(screen.getByRole('button', { name: 'New Trip' }));
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard?create=1');
  });


  // #1930: picking a list moves the route to /collections/:id, which the exact
  // match missed — the "+" then created a trip instead of adding a place.




});
