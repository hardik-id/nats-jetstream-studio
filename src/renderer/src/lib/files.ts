/**
 * Saving and picking files. Both use plain browser mechanisms, which work the same in the desktop
 * app (Electron shows its save dialog) and in web mode.
 */
export function saveBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export function saveText(name: string, text: string, type = 'application/json'): void {
  saveBlob(name, new Blob([text], { type }))
}

/** Opens the file chooser. Resolves with null when the user cancels. */
export function pickFile(accept?: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (accept) input.accept = accept
    input.style.display = 'none'
    input.onchange = () => {
      resolve(input.files?.[0] ?? null)
      input.remove()
    }
    input.oncancel = () => {
      resolve(null)
      input.remove()
    }
    document.body.appendChild(input)
    input.click()
  })
}

export function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'file'
}
