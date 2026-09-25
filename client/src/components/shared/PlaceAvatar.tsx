import React from 'react'
import { getCategoryIcon } from './categoryIcons'
import type { Place } from '../../types'

interface Category {
  color?: string
  icon?: string
}

interface PlaceAvatarProps {
  place: Pick<Place, 'id' | 'name' | 'image_url' | 'google_place_id' | 'osm_id' | 'lat' | 'lng'>
  size?: number
  category?: Category | null
}

/**
 * The avatar is the place's `image_url` or the category icon — nothing else.
 * The photo-provider fallback used to live here through photoService +
 * `/maps/place-photo/*`; both are gone, so a place without a picked image
 * (enrichment writes `image_url` when the user picks a strip candidate) shows
 * the category icon, which is also what it did while the photo was loading.
 */
export default React.memo(function PlaceAvatar({ place, size = 32, category }: PlaceAvatarProps) {
  const [photoSrc, setPhotoSrc] = React.useState<string | null>(place.image_url || null)

  React.useEffect(() => { setPhotoSrc(place.image_url || null) }, [place.image_url])

  const bgColor = category?.color || '#6366f1'
  const IconComp = getCategoryIcon(category?.icon)
  const iconSize = Math.round(size * 0.46)

  const containerStyle: React.CSSProperties = {
    width: size, height: size,
    borderRadius: '50%',
    overflow: 'hidden',
    flexShrink: 0,
    backgroundColor: bgColor,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  }

  if (photoSrc) {
    return (
      <div style={containerStyle}>
        <img
          src={photoSrc}
          alt={place.name}
          loading="lazy"
          decoding="async"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={() => setPhotoSrc(null)}
        />
      </div>
    )
  }

  return (
    <div style={containerStyle}>
      <IconComp size={iconSize} strokeWidth={1.8} color="rgba(255,255,255,0.92)" />
    </div>
  )
})
