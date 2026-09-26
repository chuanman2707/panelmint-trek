import { createPortal } from 'react-dom'
import { Ticket, Pencil } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { markdownLinkComponents } from '../shared/markdownLink'
import { useSettingsStore } from '../../store/settingsStore'
import { formatTime, splitReservationDateTime } from '../../utils/formatters'
import { RES_ICONS, TRANSPORT_DETAIL_COLORS } from './DayPlanSidebar.constants'
import type { Reservation } from '../../types'

interface DayPlanSidebarTransportDetailModalProps {
  transportDetail: Reservation | null
  setTransportDetail: (v: Reservation | null) => void
  /** Opens the edit form for this reservation (shown as a footer action). */
  onEdit?: (res: Reservation) => void
  t: (key: string, params?: Record<string, any>) => string
  locale: string
  timeFormat: string
}

export function DayPlanSidebarTransportDetailModal({
  transportDetail, setTransportDetail, onEdit, t, locale, timeFormat,
}: DayPlanSidebarTransportDetailModalProps) {
  if (!transportDetail) return null
  return createPortal(
    <div className="bg-[rgba(0,0,0,0.3)]" style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backdropFilter: 'blur(3px)',
    }}
      role="button" tabIndex={0} aria-label={t('common.cancel')}
      onClick={() => setTransportDetail(null)}
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTransportDetail(null) }
      }}>
      <div className="bg-surface-card" role="presentation" style={{
        width: 380, maxHeight: '80vh', overflowY: 'auto',
        borderRadius: 16,
        boxShadow: '0 16px 48px rgba(0,0,0,0.22)', padding: '22px 22px 18px',
        display: 'flex', flexDirection: 'column', gap: 14,
      }} onClick={e => e.stopPropagation()}>
        {(() => {
          const res = transportDetail
          const TransportIcon = RES_ICONS[res.type] || Ticket
          const TRANSPORT_COLORS = TRANSPORT_DETAIL_COLORS
          const color = TRANSPORT_COLORS[res.type] || 'var(--text-muted)'
          const meta = typeof res.metadata === 'string' ? JSON.parse(res.metadata || '{}') : (res.metadata || {})

          const detailFields = []
          if (res.type === 'flight') {
            if (meta.airline) detailFields.push({ label: t('reservations.meta.airline'), value: meta.airline })
            if (meta.flight_number) detailFields.push({ label: t('reservations.meta.flightNumber'), value: meta.flight_number })
            if (meta.departure_airport) detailFields.push({ label: t('reservations.meta.from'), value: meta.departure_airport })
            if (meta.arrival_airport) detailFields.push({ label: t('reservations.meta.to'), value: meta.arrival_airport })
            if (meta.seat) detailFields.push({ label: t('reservations.meta.seat'), value: meta.seat })
          } else if (res.type === 'train') {
            if (meta.train_number) detailFields.push({ label: t('reservations.meta.trainNumber'), value: meta.train_number })
            if (meta.platform) detailFields.push({ label: t('reservations.meta.platform'), value: meta.platform })
            if (meta.seat) detailFields.push({ label: t('reservations.meta.seat'), value: meta.seat })
          }
          if (res.confirmation_number) detailFields.push({ label: t('reservations.confirmationCode'), value: res.confirmation_number, sensitive: true })
          // A stopover booking can carry its own reference per segment (#1943); the
          // flat fields above only ever describe the first leg. Marked sensitive so
          // the blur setting covers them like the booking's own code.
          if (Array.isArray(meta.legs) && meta.legs.length > 1) {
            for (const leg of meta.legs) {
              if (!leg?.confirmation_number) continue
              const segment = [leg.from, leg.to].filter(Boolean).join(' → ')
              detailFields.push({ label: segment || t('reservations.confirmationCode'), value: leg.confirmation_number, sensitive: true })
            }
          }
          if (res.location) detailFields.push({ label: t('reservations.locationAddress'), value: res.location })

          return (
            <>
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{
                  width: 36, height: 36, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  borderRadius: '50%', background: `${color}18`,
                }}>
                  <TransportIcon size={18} strokeWidth={1.8} color={color} />
                </div>
                <div style={{ flex: 1 }}>
                  <div className="text-content" style={{ fontSize: 'calc(15px * var(--fs-scale-subtitle, 1))', fontWeight: 600 }}>{res.title}</div>
                  <div className="text-content-faint" style={{ fontSize: 'calc(11px * var(--fs-scale-caption, 1))', marginTop: 2 }}>
                    {(() => {
                      const { date, time } = splitReservationDateTime(res.reservation_time)
                      const { time: endTime } = splitReservationDateTime(res.reservation_end_time)
                      const dateStr = date
                        ? new Date(date + 'T00:00:00Z').toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
                        : ''
                      const timeStr = time ? formatTime(time, locale, timeFormat) : ''
                      const endStr = endTime ? formatTime(endTime, locale, timeFormat) : ''
                      const parts: string[] = []
                      if (dateStr) parts.push(dateStr)
                      if (timeStr) parts.push(timeStr + (endStr ? ` – ${endStr}` : ''))
                      return parts.join(', ')
                    })()}
                  </div>
                </div>
                <div className={res.status === 'confirmed' ? 'bg-[rgba(22,163,74,0.1)] text-[#16a34a]' : 'bg-[rgba(217,119,6,0.1)] text-[#d97706]'} style={{
                  padding: '3px 8px', borderRadius: 6, fontSize: 'calc(10px * var(--fs-scale-caption, 1))', fontWeight: 600,
                }}>
                  {res.status === 'confirmed' ? t('planner.resConfirmed') : t('planner.resPending')}
                </div>
              </div>

              {/* Detail-Felder */}
              {detailFields.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {detailFields.map((f, i) => {
                    const shouldBlur = f.sensitive && useSettingsStore.getState().settings.blur_booking_codes
                    const valueStyle = {
                      fontSize: 'calc(12px * var(--fs-scale-body, 1))', fontWeight: 500, wordBreak: 'break-word',
                      filter: shouldBlur ? 'blur(5px)' : 'none', transition: 'filter 0.2s',
                      cursor: shouldBlur ? 'pointer' : 'default',
                      userSelect: shouldBlur ? 'none' : 'auto',
                    } as const
                    return (
                      <div key={i} className="bg-surface-tertiary" style={{ padding: '8px 10px', borderRadius: 8 }}>
                        <div className="text-content-faint" style={{ fontSize: 'calc(9px * var(--fs-scale-caption, 1))', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 3 }}>{f.label}</div>
                        {/* A hidden booking code is a reveal toggle, so it has to be a real
                            button; a plain value stays inert text and out of the tab order. */}
                        {shouldBlur ? (
                          <button
                            type="button"
                            onMouseEnter={e => { e.currentTarget.style.filter = 'none' }}
                            onMouseLeave={e => { e.currentTarget.style.filter = 'blur(5px)' }}
                            onClick={e => { const el = e.currentTarget; el.style.filter = el.style.filter === 'none' ? 'blur(5px)' : 'none' }}
                            className="text-content"
                            style={{ ...valueStyle, display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: 0, fontFamily: 'inherit' }}
                          >{f.value}</button>
                        ) : (
                          <div className="text-content" style={valueStyle}>{f.value}</div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Notizen */}
              {res.notes && (
                <div className="bg-surface-tertiary" style={{ padding: '8px 10px', borderRadius: 8 }}>
                  <div className="text-content-faint" style={{ fontSize: 'calc(9px * var(--fs-scale-caption, 1))', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 3 }}>{t('reservations.notes')}</div>
                  <div className="collab-note-md text-content" style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', wordBreak: 'break-word', overflowWrap: 'anywhere' }}><Markdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownLinkComponents}>{res.notes}</Markdown></div>
                </div>
              )}


              {/* Aktionen */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                {onEdit && (
                  <button type="button" onClick={() => onEdit(res)} className="bg-surface-tertiary text-content" style={{
                    fontSize: 'calc(12px * var(--fs-scale-body, 1))',
                    border: 'none', borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit',
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                  }}>
                    <Pencil size={12} /> {t('common.edit')}
                  </button>
                )}
                <button type="button" onClick={() => setTransportDetail(null)} className="bg-accent text-accent-text" style={{
                  fontSize: 'calc(12px * var(--fs-scale-body, 1))',
                  border: 'none', borderRadius: 8, padding: '6px 16px', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit',
                }}>
                  {t('common.close')}
                </button>
              </div>
            </>
          )
        })()}
      </div>
    </div>,
    document.body
  )
}
