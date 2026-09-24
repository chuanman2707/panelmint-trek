import { escapeHtml } from '@trek/shared'

/**
 * The picture inside a round place marker, for both the Leaflet and the GL map.
 *
 * Sized by its style and not by width/height attributes, because stylesheet rules
 * beat attributes: Tailwind's preflight gives every img `height: auto`, and
 * Leaflet's marker pane adds `width: auto`. The 48px square thumbs got away with
 * that. A picked Commons photo keeps its own proportions on the GL map and its
 * full pixel size on Leaflet, where only the rounded-off corner of a 4000px
 * image lands inside the circle, so the marker showed nothing but its category
 * colour.
 */
export function markerPhotoHtml(url: string): string {
  return `<img src="${escapeHtml(url)}" alt="" style="display:block;width:100%;height:100%;border-radius:50%;object-fit:cover;" />`
}
