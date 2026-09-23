import type { SVGProps } from 'react'

/**
 * PanelMint's square app icon, from public/icons/icon.svg.
 *
 * Inlined rather than loaded as an <img> so it takes `currentColor` and follows
 * the theme like the provider glyphs it sits next to in the document-sync flow.
 * The pin path is the icon file's, unchanged; the gradient tile is dropped so
 * the glyph stays monochrome like its neighbours.
 */
export default function TrekIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 512 512" aria-hidden className={className} {...props}>
      <path
        d="M256 96c-70.7 0-128 55.2-128 123.2 0 92.4 128 172.8 128 172.8s128-80.4 128-172.8C384 151.2 326.7 96 256 96zm0 168a44.8 44.8 0 1 1 0-89.6 44.8 44.8 0 0 1 0 89.6z"
        fill="currentColor"
      />
    </svg>
  )
}
