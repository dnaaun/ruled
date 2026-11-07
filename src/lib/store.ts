import { type IDBPDatabase, openDB } from 'idb'
import { HLC } from './hlc'
import type { Base, Card, Deck, Note, Rec, Revlog, Table } from './model'
import { TABLES } from './model'

export function randomId(len = 14): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  let s = ''
  for (const b of bytes) s += alphabet[b % 36]
  return s
}

type Maps = {
  decks: Map<string, Deck>
  notes: Map<string, Note>
  cards: Map<string, Card>
  revlog: Map<string, Revlog>
}
type RecOf<T extends Table> = Maps[T] extends Map<string, infer R> ? R : never
export type Draft<T extends Table> = Omit<RecOf<T>, 'hlc' | 'seq'>

export class Store {
  t: Maps = { decks: new Map(), notes: new Map(), cards: new Map(), revlog: new Map() }
  seq = 0
  deviceId = ''
  clock!: HLC
  version = 0
  private db?: IDBPDatabase
  private kv = new Map<string, unknown>()
  private pending = new Map<string, [Table | 'kv', string, unknown]>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<() => void>()
  /** called after local edits (not merges); sync uses this to notify peers */
  onLocalChange: (() => void) | null = null
  onAnyChange: (() => void) | null = null

  async open(name = 'ruled') {
    this.db = await openDB(name, 1, {
      upgrade(db) {
        for (const t of TABLES) db.createObjectStore(t, { keyPath: 'id' })
        db.createObjectStore('kv')
      },
    })
    let maxHlc = ''
    for (const t of TABLES) {
      const all = (await this.db.getAll(t)) as Base[]
      const map = this.t[t] as Map<string, Base>
      for (const r of all) {
        map.set(r.id, r)
        if (r.seq > this.seq) this.seq = r.seq
        if (r.hlc > maxHlc) maxHlc = r.hlc
      }
    }
    const tx = this.db.transaction('kv')
    let cursor = await tx.store.openCursor()
    while (cursor) {
      this.kv.set(String(cursor.key), cursor.value)
      cursor = await cursor.continue()
    }
    this.seq = Math.max(this.seq, (this.kv.get('seq') as number) ?? 0)
    let dev = this.kv.get('deviceId') as string | undefined
    if (!dev) {
      dev = randomId(10)
      this.setKv('deviceId', dev)
    }
    this.deviceId = dev
    this.clock = new HLC(dev)
    if (maxHlc) this.clock.recv(maxHlc)
  }

  /** In-memory only (tests). */
  openMemory(deviceId = randomId(10)) {
    this.deviceId = deviceId
    this.clock = new HLC(deviceId)
  }

  // ------------------------------------------------------------ reading

  get<T extends Table>(t: T, id: string): RecOf<T> | undefined {
    const r = (this.t[t] as Map<string, Base>).get(id)
    return r && !r.del ? (r as RecOf<T>) : undefined
  }

  all<T extends Table>(t: T): RecOf<T>[] {
    const out: RecOf<T>[] = []
    for (const r of (this.t[t] as Map<string, Base>).values()) if (!r.del) out.push(r as RecOf<T>)
    return out
  }

  // ------------------------------------------------------------ writing

  put<T extends Table>(t: T, draft: Draft<T>): RecOf<T> {
    const rec = { ...draft, hlc: this.clock.now(), seq: ++this.seq } as unknown as RecOf<T>
    this.write(t, rec as unknown as Base)
    this.changed(true)
    return rec
  }

  private depth = 0
  private dirty: { any: boolean; local: boolean } = { any: false, local: false }

  /** Several writes, one notification. */
  batch(fn: () => void) {
    this.depth++
    try {
      fn()
    } finally {
      this.depth--
      if (this.depth === 0 && this.dirty.any) {
        const local = this.dirty.local
        this.dirty = { any: false, local: false }
        this.notify(local)
      }
    }
  }

  remove(t: Table, id: string) {
    const map = this.t[t] as Map<string, Base>
    if (!map.has(id) || map.get(id)!.del) return
    const rec: Base = { id, del: 1, hlc: this.clock.now(), seq: ++this.seq }
    this.write(t, rec)
    this.changed(true)
  }

  /** Merge records from another device. Last writer (by HLC) wins. Returns number of records that changed. */
  merge(items: [Table, Rec | Base][]): number {
    let changed = 0
    for (const [t, r] of items) {
      if (!TABLES.includes(t) || !r || typeof r.id !== 'string' || typeof r.hlc !== 'string') continue
      const map = this.t[t] as Map<string, Base>
      const local = map.get(r.id)
      if (local && local.hlc >= r.hlc) continue
      this.clock.recv(r.hlc)
      this.write(t, { ...r, seq: ++this.seq })
      changed++
    }
    if (changed) this.changed(false)
    return changed
  }

  /** All records changed locally (or merged) after `seq`, in sequence order. */
  changesSince(seq: number): [Table, Base][] {
    const out: [Table, Base][] = []
    for (const t of TABLES) for (const r of (this.t[t] as Map<string, Base>).values()) if (r.seq > seq) out.push([t, r])
    out.sort((a, b) => a[1].seq - b[1].seq)
    return out
  }

  private write(t: Table, rec: Base) {
    ;(this.t[t] as Map<string, Base>).set(rec.id, rec)
    this.pending.set(`${t}/${rec.id}`, [t, rec.id, rec])
    this.pending.set('kv/seq', ['kv', 'seq', this.seq])
    this.scheduleFlush()
  }

  getKv<T>(key: string): T | undefined {
    return this.kv.get(key) as T | undefined
  }

  setKv(key: string, value: unknown) {
    this.kv.set(key, value)
    this.pending.set(`kv/${key}`, ['kv', key, value])
    this.scheduleFlush()
  }

  private scheduleFlush() {
    if (!this.db || this.flushTimer) return
    this.flushTimer = setTimeout(() => this.flush(), 50)
  }

  async flush() {
    this.flushTimer = null
    if (!this.db || this.pending.size === 0) return
    const items = [...this.pending.values()]
    this.pending.clear()
    const tx = this.db.transaction([...TABLES, 'kv'], 'readwrite')
    for (const [t, key, value] of items) {
      if (t === 'kv') tx.objectStore('kv').put(value, key)
      else tx.objectStore(t).put(value)
    }
    await tx.done
  }

  // ------------------------------------------------------------ change notification

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed(local: boolean) {
    if (this.depth) {
      this.dirty.any = true
      if (local) this.dirty.local = true
      return
    }
    this.notify(local)
  }

  private notify(local: boolean) {
    this.version++
    for (const fn of this.listeners) fn()
    this.onAnyChange?.()
    if (local) this.onLocalChange?.()
  }
}

export const store = new Store()
