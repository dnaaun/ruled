// Browser entry point for Anki import. Loaded lazily (dynamic import) so fflate, fzstd and sql.js
// stay out of the main bundle. The SQLite wasm is bundled by Vite as a local asset: no CDN, works offline.

import initSqlJs, { type SqlJsStatic } from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url'
import type { Store } from '../store'
import { type ImportOptions, type ImportSummary, importAnkiCollection } from './import'
import { readAnkiPackage } from './package'

export type { ImportProgress, ImportSummary } from './import'

let sql: Promise<SqlJsStatic> | null = null
const loadSql = () => (sql ??= initSqlJs({ locateFile: () => wasmUrl }))

export async function importAnkiPackage(s: Store, data: Uint8Array, opts: ImportOptions & { onPhase?: (phase: 'read' | 'open') => void } = {}): Promise<ImportSummary> {
  opts.onPhase?.('read')
  const SQL = await loadSql()
  opts.onPhase?.('open')
  await new Promise((r) => setTimeout(r, 0))
  const col = readAnkiPackage(data, SQL)
  return importAnkiCollection(s, col, opts)
}
