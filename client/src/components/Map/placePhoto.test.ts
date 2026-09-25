import { describe, it, expect } from 'vitest'
import { markerPhotoHtml } from './placePhoto'

function imgOf(html: string): HTMLImageElement {
  const holder = document.createElement('div')
  holder.innerHTML = html
  return holder.querySelector('img')!
}

describe('markerPhotoHtml', () => {
  it('FE-MAP-PLACEPHOTO-001: sizes the picture by its style, where no stylesheet rule can undo it', () => {
    // Preflight's `height: auto` and Leaflet's `width: auto` both outrank a width or
    // height attribute, so a photo that is not a small square has to be pinned here.
    const img = imgOf(markerPhotoHtml('https://upload.wikimedia.org/x/wide.jpg'))
    expect(img.getAttribute('src')).toBe('https://upload.wikimedia.org/x/wide.jpg')
    expect(img.style.width).toBe('100%')
    expect(img.style.height).toBe('100%')
    expect(img.hasAttribute('width')).toBe(false)
    expect(img.hasAttribute('height')).toBe(false)
  })

  it('FE-MAP-PLACEPHOTO-002: escapes the url, which a user can set', () => {
    const html = markerPhotoHtml('https://x.test/a" onerror="alert(1)" y="')
    expect(html).not.toContain('onerror="alert(1)"')
    expect(imgOf(html).getAttribute('src')).toBe('https://x.test/a" onerror="alert(1)" y="')
  })
})
