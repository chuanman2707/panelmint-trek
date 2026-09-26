import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MExportSheet from '../../../../src/mobile/screens/trip/sheets/MExportSheet'
import { buildPlanner, buildShell } from '../../../helpers/mobileTrip'
import { resetAllStores } from '../../../helpers/store'
import { fireEvent, render, screen } from '../../../helpers/render'

// FE-MOB-EXPSH-001 to FE-MOB-EXPSH-007
// This sheet reads its copy from useTranslation(), so the assertions are English.

function renderSheet(plannerOverrides: Record<string, unknown> = {}, sheetId: string | null = 'export') {
  const planner = buildPlanner(plannerOverrides)
  const shell = buildShell({ sheet: sheetId ? { id: sheetId } : null })
  const view = render(<MExportSheet planner={planner} shell={shell} />)
  return { ...view, planner, shell }
}

describe('MExportSheet', () => {
  beforeEach(() => {
    resetAllStores()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('FE-MOB-EXPSH-001: stays closed while another sheet id is active', () => {
    renderSheet({}, 'mehr')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('FE-MOB-EXPSH-002: the file export is the only row — the hosted ICS/GPX/PDF formats are cut', () => {
    renderSheet()
    expect(screen.getByRole('dialog', { name: 'Export' })).toBeInTheDocument()
    expect(screen.getByText('Export file')).toBeInTheDocument()
    expect(screen.getByText('Download the trip as a .panelmint.json file (coming soon)')).toBeInTheDocument()
    for (const label of ['PDF', 'Download .ics', 'Subscribe to calendar', 'Auto-updates in your calendar app']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }
  })

  it('FE-MOB-EXPSH-003: the export row is a stub until Phase C wires the codec', () => {
    const { planner } = renderSheet()
    fireEvent.click(screen.getByText('Export file'))
    expect(planner.toast.info).toHaveBeenCalledWith('Download the trip as a .panelmint.json file (coming soon)')
  })

  it('FE-MOB-EXPSH-013: the header close hands the dismissal back to the shell', () => {
    const { shell } = renderSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(shell.closeSheet).toHaveBeenCalledTimes(1)
  })
})
