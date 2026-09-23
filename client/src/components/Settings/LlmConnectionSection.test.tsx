// FE-COMP-LLM-001 onwards
import { render, screen } from '../../../tests/helpers/render';
import userEvent from '@testing-library/user-event';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildUser } from '../../../tests/helpers/factories';
import { useAuthStore } from '../../store/authStore';
import { ToastContainer } from '../shared/Toast';
import LlmConnectionSection from './LlmConnectionSection';

// PanelMint has no server, so the llm_* settings were pruned and the section is
// inert UI pending removal with the rest of the cut feature surface — nothing
// here hydrates or persists. These tests pin only what still renders.

function renderSection() {
  return render(
    <>
      <ToastContainer />
      <LlmConnectionSection />
    </>,
  );
}

beforeEach(() => {
  resetAllStores();
  vi.clearAllMocks();
  seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true, isLoading: false });
});

describe('LlmConnectionSection', () => {
  it('FE-COMP-LLM-001: renders the provider, model, key and multimodal fields', () => {
    renderSection();

    expect(screen.getByText('AI parsing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /OpenAI/ })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('qwen3:8b')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('API key')).toBeInTheDocument();
    expect(screen.getByText('Send documents as images')).toBeInTheDocument();
    // The endpoint was instance configuration (#1772), so it has no field here.
    expect(screen.queryByPlaceholderText('http://localhost:11434')).not.toBeInTheDocument();
  });

  it('FE-COMP-LLM-007: the provider list is exactly the two hosted ones', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: /OpenAI/ }));

    expect(await screen.findByRole('button', { name: 'Anthropic' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Local \(Ollama\)/ })).not.toBeInTheDocument();
  });

  it('FE-COMP-LLM-011: the multimodal toggle flips locally', async () => {
    const user = userEvent.setup();
    renderSection();

    const row = screen.getByText('Send documents as images').parentElement as HTMLElement;
    const toggle = row.querySelector('button') as HTMLElement;
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('FE-COMP-LLM-012: with no settings behind it any more, saving surfaces the error toast', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    await screen.findByText('Could not save AI settings');
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeEnabled();
  });
});
