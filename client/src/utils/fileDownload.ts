function triggerAnchorDownload(blobUrl: string, filename?: string): void {
  const a = document.createElement('a')
  a.href = blobUrl
  if (filename) a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { URL.revokeObjectURL(blobUrl); a.remove() }, 100)
}

/**
 * Triggers a browser download for an in-memory Blob (CSV export, generated
 * report, …). Use this instead of hand-rolling the anchor: Firefox ignores a
 * click on an anchor that is not in the document, and revoking the object URL
 * in the same tick can abort the download in other browsers.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const blobUrl = URL.createObjectURL(blob)
  triggerAnchorDownload(blobUrl, filename)
}
