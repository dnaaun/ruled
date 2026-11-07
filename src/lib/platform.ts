import { TABLES, type Table } from './model'
import type { Store } from './store'

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
const touchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0
/**
 * iPhone/iPad. iPadOS (13+) reports a desktop "Macintosh" user agent by default, so an Apple UA
 * with a multi-touch screen is an iPad: no Mac has a touchscreen.
 */
export const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)
/** The macOS desktop app (not iPadOS, not the macOS browser). */
export const isMacApp = isTauri && /Mac/.test(ua) && !isIOS && !/Mobile|Android/.test(ua)

export async function saveTextFile(filename: string, text: string): Promise<boolean> {
  if (isTauri && isIOS) {
    // iOS has no "pick a path, then write to it" dialog. The dialog plugin's save() presents
    // UIDocumentPicker's "export" mode on a file it expects in the app's Documents folder (creating
    // an empty one if it's missing) and copies that file to wherever the user picks. So write the
    // backup there first; the picker then exports the real contents. The copy left in Documents is
    // also visible in Files → On My iPhone → Ruled (UIFileSharingEnabled in Info.ios.plist).
    const { save } = await import('@tauri-apps/plugin-dialog')
    const { writeTextFile, BaseDirectory } = await import('@tauri-apps/plugin-fs')
    await writeTextFile(filename, text, { baseDir: BaseDirectory.Document })
    return (await save({ defaultPath: filename })) != null
  }
  if (isTauri) {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const { writeTextFile } = await import('@tauri-apps/plugin-fs')
    const path = await save({ defaultPath: filename, filters: [{ name: 'Ruled backup', extensions: ['json'] }] })
    if (!path) return false
    await writeTextFile(path, text)
    return true
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
  return true
}

export async function openTextFile(extensions: string[]): Promise<string | null> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const { readTextFile } = await import('@tauri-apps/plugin-fs')
    const path = await open({ multiple: false, directory: false, filters: [{ name: 'Files', extensions }] })
    if (!path || Array.isArray(path)) return null
    return readTextFile(path as string)
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = extensions.map((e) => `.${e}`).join(',')
    input.onchange = async () => resolve(input.files?.[0] ? await input.files[0].text() : null)
    input.click()
  })
}

export interface PickedFile { name: string; data: Uint8Array }

/** Pick a file and read it as bytes. Browser: <input type=file>; Tauri: native dialog + fs readFile. */
export async function openBinaryFile(extensions: string[]): Promise<PickedFile | null> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const { readFile } = await import('@tauri-apps/plugin-fs')
    // Android's picker filters by MIME type and knows nothing about .apkg, so don't filter there
    const android = /android/i.test(navigator.userAgent)
    const path = await open({ multiple: false, directory: false, filters: android ? undefined : [{ name: 'Files', extensions }] })
    if (!path || Array.isArray(path)) return null
    const p = String(path)
    let name = p.split(/[\\/]/).pop() || p
    try {
      name = decodeURIComponent(name)
    } catch { /* keep as is */ }
    return { name, data: await readFile(p) }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = extensions.map((e) => `.${e}`).join(',')
    input.onchange = async () => {
      const f = input.files?.[0]
      resolve(f ? { name: f.name, data: new Uint8Array(await f.arrayBuffer()) } : null)
    }
    input.click()
  })
}

/** A backup file is the full record log (including deletions), so importing one is a merge, never a clobber. */
export function exportBackup(s: Store): string {
  const records: Record<string, unknown[]> = {}
  for (const t of TABLES) records[t] = [...s.t[t].values()].map(({ seq: _seq, ...r }) => r)
  return JSON.stringify({ app: 'ruled', version: 1, exported: Date.now(), device: s.deviceId, records })
}

export function importBackup(s: Store, text: string): number {
  const data = JSON.parse(text)
  if (data?.app !== 'ruled' || !data.records) throw new Error('Not a Ruled backup file')
  const items: [Table, any][] = []
  for (const t of TABLES) for (const r of data.records[t] ?? []) items.push([t, r])
  return s.merge(items)
}
