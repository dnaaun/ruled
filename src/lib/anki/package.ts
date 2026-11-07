// Reading an Anki package (.apkg / .colpkg) into plain data. No Ruled-specific mapping here.
//
// A package is a zip holding one of:
//   collection.anki21b  zstd-compressed SQLite, schema 18 (Anki 2.1.50+ default export)
//   collection.anki21   SQLite, schema 11 (legacy "support older Anki versions" export)
//   collection.anki2    SQLite, schema 11 (Anki 2.0; also a dummy "please upgrade" collection in newer packages)
// plus `media` (JSON {"0": "name.jpg"} in legacy packages; zstd protobuf MediaEntries in new ones) and the
// media files themselves, stored under their index ("0", "1", …), zstd-compressed in new packages.

import { unzipSync } from 'fflate'
import { decompress as zstdDecompress } from 'fzstd'
import type { Database, SqlJsStatic } from 'sql.js'
import type { DeckConfig } from '../model'
import { decodeProto, protoBytes, protoFloats, protoNum, protoStr } from './proto'

export interface AnkiNotetype {
  id: number
  name: string
  cloze: boolean
  fields: string[]
  templates: { name: string; qfmt: string; afmt: string }[]
}
export interface AnkiDeck { id: number; name: string; filtered: boolean; confId: number }
export interface AnkiNote { id: number; guid: string; mid: number; mod: number; tags: string[]; fields: string[] }
export interface AnkiCard {
  id: number; nid: number; did: number; ord: number; type: number; queue: number; due: number
  ivl: number; factor: number; reps: number; lapses: number; left: number; odue: number; odid: number
}
export interface AnkiRevlog { id: number; cid: number; ease: number; ivl: number; lastIvl: number; factor: number; time: number; type: number }

export interface AnkiCollection {
  /** which file inside the zip the collection came from */
  source: string
  schema: number
  /** collection creation, epoch secs */
  crt: number
  schedVer: number
  /** legacy collection-wide new/review mix: 0 mix, 1 after, 2 before */
  newSpread: number
  notetypes: Map<number, AnkiNotetype>
  decks: Map<number, AnkiDeck>
  configs: Map<number, Partial<DeckConfig>>
  notes: AnkiNote[]
  cards: AnkiCard[]
  revlog: AnkiRevlog[]
  /** media file names present in the package */
  mediaNames: string[]
  /** fetch a media file's bytes by its name (null if missing) */
  media(names: string[]): Map<string, Uint8Array>
}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const isZstd = (b: Uint8Array) => b.length >= 4 && ZSTD_MAGIC.every((m, i) => b[i] === m)
const unz = (b: Uint8Array) => (isZstd(b) ? zstdDecompress(b) : b)
const utf8 = new TextDecoder()

export const COLLECTION_FILES = ['collection.anki21b', 'collection.anki21', 'collection.anki2']

export function readAnkiPackage(data: Uint8Array, SQL: SqlJsStatic): AnkiCollection {
  if (!(data[0] === 0x50 && data[1] === 0x4b)) throw new Error('Not an Anki package (expected a .apkg or .colpkg zip file)')
  const head = unzipSync(data, { filter: (f) => COLLECTION_FILES.includes(f.name) || f.name === 'media' })
  const source = COLLECTION_FILES.find((n) => head[n])
  if (!source) throw new Error('No Anki collection found in this file')
  let db: Database
  try {
    db = new SQL.Database(unz(head[source]))
    db = withoutUnicase(SQL, db)
  } catch (e) {
    throw new Error(`Could not open the collection (${(e as Error).message})`)
  }
  try {
    const col = readCollection(db)
    const mediaMap = readMediaMap(head.media)
    const byName = new Map<string, string>()
    for (const [zipName, name] of mediaMap) byName.set(name, zipName)
    return {
      source,
      ...col,
      mediaNames: [...byName.keys()],
      media(names) {
        const want = new Map<string, string>()
        for (const n of names) {
          const z = byName.get(n)
          if (z) want.set(z, n)
        }
        const out = new Map<string, Uint8Array>()
        if (!want.size) return out
        const files = unzipSync(data, { filter: (f) => want.has(f.name) })
        for (const [z, bytes] of Object.entries(files)) out.set(want.get(z)!, unz(bytes))
        return out
      },
    }
  } finally {
    db.close()
  }
}

/**
 * Schema 18 declares text columns `COLLATE unicase`, a collation registered by Anki's Rust code. SQLite refuses to
 * plan queries over those tables without it, and sql.js can't register collations, so rewrite the schema of our
 * in-memory copy to the built-in `nocase` and reopen it.
 */
function withoutUnicase(SQL: SqlJsStatic, db: Database): Database {
  const hit = db.exec("select count() from sqlite_master where sql like '%unicase%'")[0]?.values[0]?.[0]
  if (!hit) return db
  db.exec(`PRAGMA writable_schema=ON;
    UPDATE sqlite_master SET sql = replace(replace(sql, 'COLLATE unicase', 'COLLATE nocase'), 'collate unicase', 'collate nocase') WHERE sql LIKE '%unicase%';
    PRAGMA writable_schema=OFF;`)
  const bytes = db.export()
  db.close()
  return new SQL.Database(bytes)
}

/** zip entry name → media file name */
function readMediaMap(raw: Uint8Array | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!raw || !raw.length) return out
  const bytes = unz(raw)
  const text = utf8.decode(bytes).trim()
  if (text.startsWith('{')) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(text) as Record<string, string>)) out.set(k, v)
      return out
    } catch { /* fall through to protobuf */ }
  }
  // MediaEntries { repeated MediaEntry entries = 1 }, MediaEntry { string name = 1; uint32 size = 2; bytes sha1 = 3; optional uint32 legacy_zip_filename = 255 }
  const msg = decodeProto(bytes)
  ;(msg.get(1) ?? []).forEach((e, i) => {
    if (!(e instanceof Uint8Array)) return
    const m = decodeProto(e)
    const name = protoStr(m, 1)
    if (name) out.set(String(protoNum(m, 255) ?? i), name)
  })
  return out
}

type Row = Record<string, any>
function rows(db: Database, sql: string): Row[] {
  const st = db.prepare(sql)
  const out: Row[] = []
  try {
    while (st.step()) out.push(st.getAsObject())
  } finally {
    st.free()
  }
  return out
}
const tableExists = (db: Database, name: string) => rows(db, `select name from sqlite_master where type='table' and name='${name}'`).length > 0
const json = (v: unknown): any => {
  if (v == null || v === '') return {}
  try {
    return JSON.parse(typeof v === 'string' ? v : utf8.decode(v as Uint8Array))
  } catch {
    return {}
  }
}
const blob = (v: unknown): Uint8Array => (v instanceof Uint8Array ? v : new Uint8Array())
const round = (n: number, dp = 3) => Math.round(n * 10 ** dp) / 10 ** dp

function readCollection(db: Database) {
  const colRow = rows(db, 'select * from col')[0]
  if (!colRow) throw new Error('The collection is empty or damaged')
  const schema = Number(colRow.ver ?? 11)
  const crt = Number(colRow.crt)
  const notetypes = new Map<number, AnkiNotetype>()
  const decks = new Map<number, AnkiDeck>()
  const configs = new Map<number, Partial<DeckConfig>>()
  let schedVer = 1
  let newSpread = 0

  if (tableExists(db, 'notetypes')) {
    // schema 15+: one row per notetype / field / template / deck / preset, configs as protobuf
    for (const r of rows(db, 'select key as k, val as v from config')) {
      if (r.k === 'schedVer') schedVer = Number(json(r.v)) || schedVer
      if (r.k === 'newSpread') newSpread = Number(json(r.v)) || 0
    }
    for (const r of rows(db, 'select id, name, config from notetypes')) {
      const cfg = decodeProto(blob(r.config))
      notetypes.set(Number(r.id), { id: Number(r.id), name: String(r.name), cloze: protoNum(cfg, 1) === 1, fields: [], templates: [] })
    }
    // no ORDER BY here (or anywhere): Anki's indexes use its custom `unicase` collation, which sql.js doesn't have
    const byOrd = (a: Row, b: Row) => Number(a.ntid) - Number(b.ntid) || Number(a.ord) - Number(b.ord)
    for (const r of rows(db, 'select ntid, ord, name from fields').sort(byOrd)) notetypes.get(Number(r.ntid))?.fields.push(String(r.name))
    for (const r of rows(db, 'select ntid, ord, name, config from templates').sort(byOrd)) {
      const cfg = decodeProto(blob(r.config))
      notetypes.get(Number(r.ntid))?.templates.push({ name: String(r.name), qfmt: protoStr(cfg, 1) ?? '', afmt: protoStr(cfg, 2) ?? '' })
    }
    for (const r of rows(db, 'select id, name, kind from decks')) {
      // Deck.KindContainer { oneof kind { Normal normal = 1; Filtered filtered = 2 } }, Normal { int64 config_id = 1 }
      const kind = decodeProto(blob(r.kind))
      const normal = protoBytes(kind, 1)
      decks.set(Number(r.id), {
        id: Number(r.id),
        name: String(r.name).split('\x1f').join('::'),
        filtered: !normal && kind.has(2),
        confId: normal ? protoNum(decodeProto(normal), 1) ?? 1 : 1,
      })
    }
    for (const r of rows(db, 'select id, config from deck_config')) configs.set(Number(r.id), configFromProto(blob(r.config)))
  } else {
    const conf = json(colRow.conf)
    schedVer = Number(conf.schedVer) || 1
    newSpread = Number(conf.newSpread) || 0
    for (const m of Object.values(json(colRow.models)) as any[]) {
      notetypes.set(Number(m.id), {
        id: Number(m.id),
        name: String(m.name ?? ''),
        cloze: m.type === 1,
        fields: [...(m.flds ?? [])].sort((a, b) => a.ord - b.ord).map((f: any) => String(f.name)),
        templates: [...(m.tmpls ?? [])].sort((a, b) => a.ord - b.ord).map((t: any) => ({ name: String(t.name), qfmt: String(t.qfmt ?? ''), afmt: String(t.afmt ?? '') })),
      })
    }
    for (const d of Object.values(json(colRow.decks)) as any[]) {
      decks.set(Number(d.id), { id: Number(d.id), name: String(d.name), filtered: !!d.dyn, confId: Number(d.conf ?? 1) })
    }
    for (const c of Object.values(json(colRow.dconf)) as any[]) configs.set(Number(c.id), configFromLegacy(c))
  }

  const notes: AnkiNote[] = rows(db, 'select id, guid, mid, mod, tags, flds from notes').map((r) => ({
    id: Number(r.id),
    guid: String(r.guid),
    mid: Number(r.mid),
    mod: Number(r.mod),
    tags: String(r.tags ?? '').split(/\s+/).filter(Boolean),
    fields: String(r.flds ?? '').split('\x1f'),
  }))
  const cards = rows(db, 'select id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses, left, odue, odid from cards') as AnkiCard[]
  for (const c of cards) for (const k of Object.keys(c) as (keyof AnkiCard)[]) c[k] = Number(c[k])
  const revlog = tableExists(db, 'revlog')
    ? (rows(db, 'select id, cid, ease, ivl, lastIvl, factor, time, type from revlog') as AnkiRevlog[]).sort((a, b) => Number(a.id) - Number(b.id))
    : []
  for (const r of revlog) for (const k of Object.keys(r) as (keyof AnkiRevlog)[]) r[k] = Number(r[k])
  return { schema, crt, schedVer, newSpread, notetypes, decks, configs, notes, cards, revlog }
}

const MIX: DeckConfig['newMix'][] = ['mix', 'after', 'before']

/** anki/proto/anki/deck_config.proto DeckConfig.Config */
function configFromProto(buf: Uint8Array): Partial<DeckConfig> {
  const m = decodeProto(buf)
  const c: Partial<DeckConfig> = {}
  const set = <K extends keyof DeckConfig>(k: K, v: DeckConfig[K] | undefined) => { if (v !== undefined && !(typeof v === 'number' && !Number.isFinite(v))) c[k] = v }
  const learn = protoFloats(m, 1)
  const relearn = protoFloats(m, 2)
  if (m.has(1)) set('learnSteps', learn.map((x) => round(x, 4)))
  if (m.has(2)) set('relearnSteps', relearn.map((x) => round(x, 4)))
  // proto3 omits zero values, so a missing numeric field means 0, not "unset"
  set('newPerDay', protoNum(m, 9) ?? 0)
  set('reviewsPerDay', protoNum(m, 10) ?? 0)
  const f = (n: number) => { const v = protoNum(m, n); return v === undefined ? undefined : round(v) }
  set('initialEase', f(11))
  set('easyBonus', f(12))
  set('hardFactor', f(13))
  set('lapseMult', f(14) ?? 0)
  set('ivlModifier', f(15))
  set('maxIvl', protoNum(m, 16))
  set('minLapseIvl', protoNum(m, 17))
  set('graduatingIvl', protoNum(m, 18))
  set('easyIvl', protoNum(m, 19))
  set('newMix', MIX[protoNum(m, 30) ?? 0] ?? 'mix')
  set('leechAction', (protoNum(m, 21) ?? 0) === 1 ? 'tag' : 'suspend')
  set('leechThreshold', protoNum(m, 22))
  return c
}

/** Schema 11 `dconf` JSON preset. */
function configFromLegacy(d: any): Partial<DeckConfig> {
  const c: Partial<DeckConfig> = {}
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const put = <K extends keyof DeckConfig>(k: K, v: DeckConfig[K] | undefined) => { if (v !== undefined) c[k] = v }
  const nw = d.new ?? {}
  const rev = d.rev ?? {}
  const lapse = d.lapse ?? {}
  if (Array.isArray(nw.delays)) put('learnSteps', nw.delays.filter((x: unknown) => typeof x === 'number'))
  if (Array.isArray(lapse.delays)) put('relearnSteps', lapse.delays.filter((x: unknown) => typeof x === 'number'))
  put('newPerDay', num(nw.perDay))
  put('reviewsPerDay', num(rev.perDay))
  put('graduatingIvl', num(nw.ints?.[0]))
  put('easyIvl', num(nw.ints?.[1]))
  const ease = num(nw.initialFactor)
  put('initialEase', ease === undefined ? undefined : ease / 1000)
  put('easyBonus', num(rev.ease4))
  put('hardFactor', num(rev.hardFactor))
  put('ivlModifier', num(rev.ivlFct))
  put('maxIvl', num(rev.maxIvl))
  put('lapseMult', num(lapse.mult))
  put('minLapseIvl', num(lapse.minInt))
  put('leechThreshold', num(lapse.leechFails))
  if (lapse.leechAction != null) put('leechAction', lapse.leechAction === 1 ? 'tag' : 'suspend')
  return c
}
