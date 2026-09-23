// FE-MOB-SETLLM-001 onwards
import { describe, it, expect, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '../../../helpers/render';
import { resetAllStores, seedStore } from '../../../helpers/store';
import { buildUser } from '../../../helpers/factories';
import { useAuthStore } from '../../../../src/store/authStore';
import { ToastContainer } from '../../../../src/components/shared/Toast';
import MLlmConnectionSection from '../../../../src/mobile/screens/settings/MLlmConnectionSection';

// PanelMint has no server, so the llm_* settings were pruned and the section is
// inert UI pending removal with the rest of the cut feature surface — nothing
// here hydrates or persists. These tests pin only what still renders.

function renderSection() {
  return render(
    <>
      <ToastContainer />
      <MLlmConnectionSection />
    </>,
  );
}

describe('MLlmConnectionSection', () => {
  beforeEach(() => {
    resetAllStores();
    seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true, isLoading: false });
  });

  it('FE-MOB-SETLLM-001: renders the provider, model, key and multimodal rows', () => {
    renderSection();

    expect(screen.getByText('AI parsing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /OpenAI/ })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('qwen3:8b')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('API key')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Send documents as images' })).toBeInTheDocument();
    // The endpoint was instance configuration (#1772), so it has no row here.
    expect(screen.queryByPlaceholderText('http://localhost:11434')).not.toBeInTheDocument();
  });

  it('FE-MOB-SETLLM-007: the picker offers exactly the two hosted providers', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: /OpenAI/ }));

    expect(await screen.findByRole('button', { name: 'Anthropic' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Local \(Ollama\)/ })).not.toBeInTheDocument();
  });

  it('FE-MOB-SETLLM-011: the multimodal switch flips locally', async () => {
    const user = userEvent.setup();
    renderSection();

    const toggle = screen.getByRole('switch', { name: 'Send documents as images' });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('FE-MOB-SETLLM-012: with no settings behind it any more, saving surfaces the error toast', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: /Save/ }));

    await screen.findByText('Could not save AI settings');
    expect(screen.getByRole('button', { name: /Save/ })).toBeEnabled();
  });
});
