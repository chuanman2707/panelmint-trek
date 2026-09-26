import { useState } from 'react'
import TripFormModal from '../../../../components/Trips/TripFormModal'
import type { ExpensePrefill } from '../../../../components/Budget/CostsPanel'
import { useAuthStore } from '../../../../store/authStore'
import { useSettingsStore } from '../../../../store/settingsStore'
import { useTripStore } from '../../../../store/tripStore'
import MConfirmSheet from '../../settings/MConfirmSheet'
import MDaySheet from './MDaySheet'
import MDaysSheet from './MDaysSheet'
import MAccommodationSheet from './MAccommodationSheet'
import MPlaceSheet from './MPlaceSheet'
import MPlaceEditSheet from './MPlaceEditSheet'
import MReservationSheet from './MReservationSheet'
import MTransportFormSheet from './MTransportFormSheet'
import MCostSheet from './MCostSheet'
import MTransportSheet from './MTransportSheet'
import MBrowseActionsSheet from './MBrowseActionsSheet'
import MNoteSheet, { type MNoteSheetPayload } from './MNoteSheet'
import MExportSheet from './MExportSheet'
import MMehrSheet from './MMehrSheet'
import type { BookingExpenseRequest } from '../../../../components/Planner/BookingCostsSection.types'
import type { BudgetItem } from '../../../../types'
import type { MTripSheetsProps } from '../MTripShell'

/**
 * Sheet host of the mobile trip screen — always mounted below the shell. Two
 * families live here: the mobile sheets routed via shell.sheet (day, days,
 * transport, bract, note, import, export, mehr — the place inspector keys off
 * the planner's place selection instead), and the planner-flag editors that
 * every entry point (?create=, import review, timeline, map long-press) opens
 * through useTripPlanner state. The transport/booking/import/member
 * editors reuse the shared desktop modals until they get mobile counterparts;
 * they carry the full behaviour (undo, WS sync, review flow) unchanged.
 */
export default function MTripSheets({ planner, shell }: MTripSheetsProps) {
  const { t, toast, tripId, trip, tripActions } = planner
  const sheet = shell.sheet

  // Booking-linked expense editor (save-then-open from the booking modals) —
  // same page-level wiring as the desktop planner.
  const meId = useAuthStore(s => s.user?.id ?? -1)
  const displayCurrency = useSettingsStore(s => s.settings.default_currency)
  const loadBudgetItems = useTripStore(s => s.loadBudgetItems)
  const [bookingExpense, setBookingExpense] = useState<{ editing: BudgetItem | null; prefill?: ExpensePrefill } | null>(null)
  const openBookingExpense = (req: BookingExpenseRequest) => {
    if (req.editItem) setBookingExpense({ editing: req.editItem })
    else if (req.prefill) setBookingExpense({ editing: null, prefill: req.prefill })
  }
  const costsBase = (displayCurrency || trip?.currency || 'EUR').toUpperCase()

  return (
    <>
      {/* ── Mobile sheets (shell.sheet routing + the place selection) ── */}
      <MPlaceSheet planner={planner} shell={shell} />
      <MDaySheet planner={planner} shell={shell} />
      <MDaysSheet planner={planner} shell={shell} />
      <MAccommodationSheet planner={planner} shell={shell} />
      <MTransportSheet planner={planner} shell={shell} />
      <MBrowseActionsSheet planner={planner} shell={shell} />
      <MMehrSheet planner={planner} shell={shell} />
      <MExportSheet planner={planner} shell={shell} />
      <MNoteSheet
        planner={planner}
        open={sheet?.id === 'note'}
        payload={sheet?.id === 'note' ? (sheet.payload as MNoteSheetPayload) : undefined}
        onClose={shell.closeSheet}
      />

      {/* ── Planner-flag editors (also serve ?create= and the import review) ── */}
      <MPlaceEditSheet planner={planner} onOpenExpense={openBookingExpense} />

      <MReservationSheet planner={planner} onOpenExpense={openBookingExpense} />

      <MTransportFormSheet planner={planner} onOpenExpense={openBookingExpense} />

      {bookingExpense && (
        <MCostSheet
          tripId={tripId}
          base={costsBase}
          people={planner.tripMembers}
          me={meId}
          editing={bookingExpense.editing}
          prefill={bookingExpense.prefill}
          onClose={() => setBookingExpense(null)}
          onSaved={() => { setBookingExpense(null); loadBudgetItems(tripId) }}
        />
      )}


      {/* Trip edit + share/members, opened from the Mehr sheet. */}
      <TripFormModal
        isOpen={sheet?.id === 'tripedit'}
        onClose={shell.closeSheet}
        onSave={async (data) => {
          await tripActions.updateTrip(tripId, data)
          toast.success(t('trip.toast.tripUpdated'))
        }}
        trip={trip}
      />

      {/* Delete-place confirm behind handleDeletePlace (the place edit sheet
          arms the same flag for its own two-tap delete — skip it there).
          A night booked at the place goes down with it, and with the night
          the booking and its expense: the planner adds that as a second
          sentence, the same one the desktop question carries. */}
      <MConfirmSheet
        open={planner.deletePlaceId != null && !planner.showPlaceForm}
        onClose={() => planner.setDeletePlaceId(null)}
        title={t('common.delete')}
        message={planner.deletePlaceNote ? (
          <>
            <span className="block">{t('trip.confirm.deletePlace')}</span>
            <span className="mt-1 block">{planner.deletePlaceNote}</span>
          </>
        ) : t('trip.confirm.deletePlace')}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        onConfirm={() => {
          void planner.confirmDeletePlace()
          planner.setDeletePlaceId(null)
        }}
      />
    </>
  )
}
