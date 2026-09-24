import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { act } from 'react'
import { render } from '../../../tests/helpers/render'
import OfflineBanner from './OfflineBanner'
import { _resetNetworkMode, setForcedOffline } from '../../sync/networkMode'

afterEach(() => {
  vi.clearAllMocks()
  _resetNetworkMode()
  Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true })
})

describe('OfflineBanner', () => {
  it('stays hidden while online', () => {
    const { container } = render(<OfflineBanner />)
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('shows the offline pill when the browser reports no connectivity', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true })
    render(<OfflineBanner />)
    expect(await screen.findByRole('status')).toBeInTheDocument()
  })

  it('shows the forced-offline pill when the user forced offline mode', async () => {
    render(<OfflineBanner />)
    await act(async () => { setForcedOffline(true) })
    expect(await screen.findByRole('status')).toBeInTheDocument()
  })
})
