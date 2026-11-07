/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { zstdCompressSync } from 'node:zlib'
import { zipSync } from 'fflate'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { beforeAll, describe, expect, it } from 'vitest'
import { convertField, dayOffset, deckIdFor, importAnkiCollection, mapRevlog, noteIdFor } from '../src/lib/anki/import'
import { readAnkiPackage } from '../src/lib/anki/package'
import { buildQueue } from '../src/lib/ops'
import { renderCloze } from '../src/lib/render'
import { timing } from '../src/lib/scheduler/timing'
import { Store } from '../src/lib/store'

let SQL: SqlJsStatic
beforeAll(async () => {
  SQL = await initSqlJs()
})

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))
const expected = JSON.parse(readFileSync(new URL('./fixtures/sample.json', import.meta.url), 'utf8'))

function mem() {
  const s = new Store()
  s.openMemory('test')
  return s
}
const noteByFront = (s: Store, front: string) => s.all('notes').find((n) => (n.fields.front ?? n.fields.text).startsWith(front))!

describe('dayOffset', () => {
  it('maps Anki day 0 to the local calendar date of collection creation', () => {
    const crt = new Date(2024, 0, 15, 4, 0).getTime() / 1000
    expect(dayOffset(crt)).toBe(Date.UTC(2024, 0, 15) / 86_400_000)
    // created just after midnight still counts as that date
    expect(dayOffset(new Date(2024, 0, 15, 0, 30).getTime() / 1000)).toBe(Date.UTC(2024, 0, 15) / 86_400_000)
  })
})

describe('convertField', () => {
  it('strips sounds and embeds or replaces images', () => {
    const imgs = new Map([['a b.png', 'data:image/png;base64,AAAA']])
    expect(convertField('hi [sound:x.mp3] there', imgs)).toBe('hi  there')
    expect(convertField('<img src="a%20b.png">', imgs)).toBe('<img src="data:image/png;base64,AAAA" alt="a b.png">')
    expect(convertField("<img class='x' src='missing.jpg' />", imgs)).toContain('[image: missing.jpg]')
    expect(convertField('<img src="https://example.com/x.png">', imgs)).toBe('<img src="https://example.com/x.png">')
  })
})

describe('mapRevlog', () => {
  const r = { id: 1, cid: 2, ivl: -600, lastIvl: 0, factor: 0, time: 4000, type: 0, ease: 2 }
  it('maps v1 three-button learning answers onto four buttons', () => {
    expect(mapRevlog(r, 1)?.rating).toBe(3)
    expect(mapRevlog(r, 2)?.rating).toBe(2)
    expect(mapRevlog({ ...r, type: 1, ease: 2 }, 1)?.rating).toBe(2)
  })
  it('sets kind and source queue', () => {
    expect(mapRevlog(r, 2)).toMatchObject({ kind: 0, from: 'new', taken: 4000, time: 1 })
    expect(mapRevlog({ ...r, lastIvl: -60 }, 2)?.from).toBe('learn')
    expect(mapRevlog({ ...r, type: 2 }, 2)).toMatchObject({ kind: 2, from: 'learn' })
    expect(mapRevlog({ ...r, type: 3, ease: 3 }, 2)).toMatchObject({ kind: 1, from: 'review' })
    expect(mapRevlog({ ...r, type: 4, ease: 0 }, 2)).toBeNull()
    expect(mapRevlog({ ...r, type: 5, ease: 0 }, 2)).toBeNull()
  })
})

// ---------------------------------------------------------------- packages written by real Anki

describe.each([
  ['sample.apkg', 'collection.anki21b'],
  ['sample-legacy.apkg', 'collection.anki21'],
  ['sample.colpkg', 'collection.anki21b'],
])('Anki-made package %s', (file, source) => {
  it('imports notes, scheduling, history and options', async () => {
    const col = readAnkiPackage(fixture(file), SQL)
    expect(col.source).toBe(source)
    const s = mem()
    const sum = await importAnkiCollection(s, col)
    const off = dayOffset(expected.crt)

    // decks: only the ones with cards; the empty parent and "Default" are skipped
    expect(s.all('decks').map((d) => d.name).sort()).toEqual(['Geography', 'Languages::French'])
    const fr = s.get('decks', deckIdFor('Languages::French'))!
    expect(fr.config).toMatchObject({
      newPerDay: 7, reviewsPerDay: 150, learnSteps: [2, 15, 60], relearnSteps: [5, 30], graduatingIvl: 2, easyIvl: 5,
      initialEase: 2.3, easyBonus: 1.4, hardFactor: 1.1, ivlModifier: 0.9, lapseMult: 0.2, minLapseIvl: 2, maxIvl: 3650,
      leechThreshold: 6, leechAction: 'suspend',
    })
    expect(s.get('decks', deckIdFor('Geography'))!.config).toMatchObject({ newPerDay: 20, learnSteps: [1, 10], leechAction: 'tag' })

    // notes and kinds
    expect(s.all('notes')).toHaveLength(6)
    expect(sum).toMatchObject({ notesAdded: 6, cardsAdded: 9, reviewsAdded: expected.revlog })
    const kinds = Object.fromEntries(s.all('notes').map((n) => [(n.fields.front ?? n.fields.text).slice(0, 8), n.kind]))
    expect(kinds).toEqual({ bonjour: 'basic', chat: 'reversed', Paris: 'basic', Rome: 'reversed', '{{c1::Ca': 'cloze', untouche: 'basic' })
    const bonjour = noteByFront(s, 'bonjour')
    expect(bonjour.fields.back).toBe('hello')
    expect(bonjour.tags).toEqual(['fr', 'greet::basic'])
    expect(bonjour.deckId).toBe(fr.id)
    expect(noteByFront(s, 'chat').fields.back).toMatch(/^cat <img src="data:image\/png;base64,/)
    expect(noteByFront(s, 'Rome').fields.back).toBe('capital of Italy') // "Add Reverse" flag is not content
    const cloze = noteByFront(s, '{{c1::')
    expect(cloze.fields).toEqual({ text: '{{c1::Canberra}} is the capital of {{c2::Australia::country}}', extra: 'extra info' })
    expect(renderCloze(cloze.fields.text, 2, 'front')).toContain('country')

    const card = (front: string, ord: number) => s.get('cards', `${noteByFront(s, front).id}.${ord}`)!
    const e = expected.cards
    // learning, with a real intraday due timestamp
    expect(card('bonjour', 0)).toMatchObject({ type: 1, queue: 1, due: e['bonjour#0'].due, left: 1, reps: 2 })
    expect(card('bonjour', 0).stepSecs).toBeGreaterThan(0)
    expect(card('chat', 0)).toMatchObject({ type: 1, queue: 1, left: 2, reps: 1 })
    expect(card('chat', 1)).toMatchObject({ type: 0, queue: 0, due: e['chat#1'].due })
    // suspended review: queue restored from type, due converted to a Ruled day
    expect(card('Paris', 0)).toMatchObject({ type: 2, queue: 2, suspended: true, ivl: 3, factor: 2500, due: off + e['Paris#0'].due })
    expect(s.get('cards', `${noteByFront(s, 'Paris').id}.1`)).toBeUndefined()
    // relearning
    expect(card('Rome', 0)).toMatchObject({ type: 3, queue: 1, lapses: 1, left: 1, factor: 2300, ivl: 1, due: e['Rome#0'].due })
    // buried review comes back unburied; cloze ords are the cloze numbers
    expect(card('{{c1::', 1)).toMatchObject({ type: 2, queue: 2, due: off + e['{{c1::Canber#0'].due, ivl: 5 })
    expect(card('{{c1::', 1).suspended).toBeFalsy()
    expect(card('{{c1::', 2)).toMatchObject({ type: 0, queue: 0 })

    // review history
    const revs = s.all('revlog')
    expect(revs).toHaveLength(expected.revlog)
    for (const r of revs) {
      expect(s.get('cards', r.cardId)).toBeTruthy()
      expect(r.deckId).toBe(s.get('cards', r.cardId)!.deckId)
      expect(r.hlc).toBeTruthy()
    }
    const rome = revs.filter((r) => r.cardId === card('Rome', 0).id).sort((a, b) => a.time - b.time)
    expect(rome.map((r) => [r.rating, r.kind, r.from])).toEqual([[4, 0, 'new'], [1, 1, 'review']])

    // everything went through the store with HLC stamps
    for (const t of ['decks', 'notes', 'cards'] as const) for (const r of s.all(t)) expect(r.hlc).toBeTruthy()

    // the imported cards are studiable
    const q = buildQueue(s, fr.id, timing((expected.crt + 3600 * 12) * 1000))
    expect(q.counts.total).toBe(3)
  })

  it('re-importing merges instead of duplicating', async () => {
    const s = mem()
    await importAnkiCollection(s, readAnkiPackage(fixture(file), SQL))
    const before = { n: s.all('notes').length, c: s.all('cards').length, r: s.all('revlog').length, d: s.all('decks').length }
    const sum = await importAnkiCollection(s, readAnkiPackage(fixture(file), SQL))
    expect({ n: s.all('notes').length, c: s.all('cards').length, r: s.all('revlog').length, d: s.all('decks').length }).toEqual(before)
    expect(sum).toMatchObject({ notesAdded: 0, cardsAdded: 0, reviewsAdded: 0, notesUnchanged: 6, cardsUnchanged: 9, reviewsExisting: expected.revlog })
    expect(sum.decks.every((d) => !d.created)).toBe(true)
  })
})

it('the legacy and new exports of one collection land on the same records', async () => {
  const a = mem()
  await importAnkiCollection(a, readAnkiPackage(fixture('sample.apkg'), SQL))
  const sum = await importAnkiCollection(a, readAnkiPackage(fixture('sample-legacy.apkg'), SQL))
  expect(sum.notesAdded + sum.cardsAdded + sum.reviewsAdded).toBe(0)
  expect(a.all('notes')).toHaveLength(6)
})

// ---------------------------------------------------------------- hand-built collections

const SCHEMA11 = `
create table col (id integer primary key, crt integer, mod integer, scm integer, ver integer, dty integer, usn integer, ls integer, conf text, models text, decks text, dconf text, tags text);
create table notes (id integer primary key, guid text, mid integer, mod integer, usn integer, tags text, flds text, sfld text, csum integer, flags integer, data text);
create table cards (id integer primary key, nid integer, did integer, ord integer, mod integer, usn integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer, left integer, odue integer, odid integer, flags integer, data text);
create table revlog (id integer primary key, cid integer, usn integer, ease integer, ivl integer, lastIvl integer, factor integer, time integer, type integer);
`
type CardRow = { id: number; nid: number; did: number; ord: number; type: number; queue: number; due: number; ivl?: number; factor?: number; reps?: number; lapses?: number; left?: number; odue?: number; odid?: number }
function insertNotes(db: any, notes: [number, string, number, string, string[]][], cards: CardRow[], revlog: number[][]) {
  for (const [id, guid, mid, tags, flds] of notes) db.run('insert into notes values (?,?,?,?,0,?,?,?,0,0,"")', [id, guid, mid, 1_700_000_000, tags, flds.join('\x1f'), flds[0]])
  for (const c of cards) {
    db.run('insert into cards values (?,?,?,?,0,0,?,?,?,?,?,?,?,?,?,?,0,"")', [
      c.id, c.nid, c.did, c.ord, c.type, c.queue, c.due, c.ivl ?? 0, c.factor ?? 0, c.reps ?? 0, c.lapses ?? 0, c.left ?? 0, c.odue ?? 0, c.odid ?? 0,
    ])
  }
  for (const r of revlog) db.run('insert into revlog values (?,?,0,?,?,?,?,?,?)', r)
}

const CRT = new Date(2023, 5, 1, 4, 0).getTime() / 1000
const OFF = Date.UTC(2023, 5, 1) / 86_400_000

function legacyPackage(): Uint8Array {
  const db = new SQL.Database()
  db.run(SCHEMA11)
  const models = {
    10: { id: 10, name: 'Basic', type: 0, flds: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }], tmpls: [{ name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}' }] },
    11: { id: 11, name: 'Cloze', type: 1, flds: [{ name: 'Text', ord: 0 }, { name: 'Extra', ord: 1 }], tmpls: [{ name: 'Cloze', ord: 0, qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>{{Extra}}' }] },
    12: {
      id: 12, name: 'Vocab (3 cards)', type: 0,
      flds: [{ name: 'Word', ord: 0 }, { name: 'Meaning', ord: 1 }, { name: 'Example', ord: 2 }],
      tmpls: [0, 1, 2].map((o) => ({ name: `C${o}`, ord: o, qfmt: `{{Word}}`, afmt: '{{Meaning}} {{Example}}' })),
    },
  }
  const decks = {
    1: { id: 1, name: 'Default', dyn: 0, conf: 1 },
    20: { id: 20, name: 'Spanish::Verbs', dyn: 0, conf: 2 },
    30: { id: 30, name: 'Filtered Deck 1', dyn: 1 },
  }
  const dconf = {
    1: { id: 1, new: { perDay: 20, delays: [1, 10], ints: [1, 4, 0], initialFactor: 2500 }, rev: { perDay: 200, ease4: 1.3, ivlFct: 1, maxIvl: 36500, hardFactor: 1.2 }, lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 1 } },
    2: { id: 2, new: { perDay: 5, delays: [3], ints: [3, 6, 0], initialFactor: 2100 }, rev: { perDay: 99, ease4: 1.5, ivlFct: 1.1, maxIvl: 1000, hardFactor: 1.3 }, lapse: { delays: [20, 40], mult: 0.5, minInt: 3, leechFails: 5, leechAction: 0 } },
  }
  db.run('insert into col values (1,?,0,0,11,0,0,0,?,?,?,?,"{}")', [CRT, JSON.stringify({ schedVer: 1, newSpread: 1 }), JSON.stringify(models), JSON.stringify(decks), JSON.stringify(dconf)])
  insertNotes(
    db,
    [
      [1001, 'g.1/x', 10, ' verb  leech ', ['<b>hablar</b>', 'to speak <img src="pic.jpg"><img src="big.png">']],
      [1002, 'g2', 11, '', ['{{c1::Madrid}} es la {{c3::capital}}', '']],
      [1003, 'g3', 12, 'vocab', ['casa', 'house', '']],
      [1004, 'g4', 10, '', ['', '']],
    ],
    [
      // review due on Anki day 100, sitting in a filtered deck (original deck + due kept in odid/odue)
      { id: 2001, nid: 1001, did: 30, ord: 0, type: 2, queue: 2, due: -5, odue: 100, odid: 20, ivl: 30, factor: 2650, reps: 9, lapses: 1 },
      // interday learning card (queue 3), legacy left = today*1000 + remaining
      { id: 2002, nid: 1002, did: 20, ord: 0, type: 1, queue: 3, due: 120, left: 2002, reps: 1 },
      // buried new card
      { id: 2003, nid: 1002, did: 20, ord: 2, type: 0, queue: -2, due: 7 },
      // a cloze card whose number was removed from the text
      { id: 2005, nid: 1002, did: 20, ord: 4, type: 0, queue: 0, due: 8 },
      { id: 2010, nid: 1003, did: 20, ord: 0, type: 0, queue: 0, due: 3 },
      { id: 2011, nid: 1003, did: 20, ord: 1, type: 0, queue: 0, due: 4 },
      { id: 2012, nid: 1003, did: 20, ord: 2, type: 0, queue: 0, due: 5 },
      { id: 2020, nid: 1004, did: 20, ord: 0, type: 0, queue: 0, due: 6 },
    ],
    [
      [1_690_000_000_000, 2001, 2, -60, 0, 0, 5000, 0], // v1 learn "good" (2 of 3) → 3
      [1_690_000_100_000, 2001, 3, 1, -60, 2500, 3000, 0], // v1 learn "easy" → 4
      [1_691_000_000_000, 2001, 3, 30, 10, 2650, 8000, 1],
      [1_692_000_000_000, 2001, 0, 40, 30, 2650, 0, 4], // manual reschedule: skipped
      [1_693_000_000_000, 9999, 3, 4, 1, 2500, 1000, 1], // orphan: skipped
    ],
  )
  const bytes = db.export()
  db.close()
  return zipSync({
    'collection.anki2': bytes,
    media: new TextEncoder().encode(JSON.stringify({ 0: 'pic.jpg', 1: 'big.png' })),
    0: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
    1: new Uint8Array(400_000),
  })
}

describe('legacy schema (collection.anki2)', () => {
  it('maps note types, filtered decks, legacy left, v1 ratings and options', async () => {
    const col = readAnkiPackage(legacyPackage(), SQL)
    expect(col.source).toBe('collection.anki2')
    const s = mem()
    const sum = await importAnkiCollection(s, col)
    expect(s.all('decks').map((d) => d.name)).toEqual(['Spanish::Verbs'])
    const deck = s.all('decks')[0]
    expect(deck.config).toMatchObject({ newPerDay: 5, reviewsPerDay: 99, learnSteps: [3], relearnSteps: [20, 40], graduatingIvl: 3, easyIvl: 6, initialEase: 2.1, easyBonus: 1.5, ivlModifier: 1.1, hardFactor: 1.3, maxIvl: 1000, lapseMult: 0.5, minLapseIvl: 3, leechThreshold: 5, leechAction: 'suspend', newMix: 'after' })

    const n1 = s.get('notes', noteIdFor('g.1/x'))!
    expect(n1).toMatchObject({ kind: 'basic', tags: ['verb', 'leech'], deckId: deck.id, created: 1001, mod: 1_700_000_000_000 })
    expect(n1.fields.front).toBe('<b>hablar</b>')
    expect(n1.fields.back).toContain('data:image/jpeg;base64,')
    expect(n1.fields.back).toContain('[image: big.png]')
    expect(sum).toMatchObject({ imagesEmbedded: 1, imagesDropped: 1 })

    expect(s.get('cards', `${n1.id}.0`)).toMatchObject({ type: 2, queue: 2, due: OFF + 100, ivl: 30, factor: 2650, reps: 9, lapses: 1, deckId: deck.id })

    const cloze = s.get('notes', noteIdFor('g2'))!
    expect(cloze.kind).toBe('cloze')
    expect(s.get('cards', `${cloze.id}.1`)).toMatchObject({ type: 1, queue: 3, due: OFF + 120, left: 2, stepSecs: 180 })
    expect(s.get('cards', `${cloze.id}.3`)).toMatchObject({ type: 0, queue: 0, due: 7 })
    expect(s.get('cards', `${cloze.id}.3`)!.buriedUntil).toBeUndefined()
    expect(s.get('cards', `${cloze.id}.5`)).toBeUndefined()

    const vocab = s.get('notes', noteIdFor('g3'))!
    expect(vocab).toMatchObject({ kind: 'basic', fields: { front: 'casa', back: 'house' } })
    expect(s.all('cards').filter((c) => c.noteId === vocab.id)).toHaveLength(1)
    expect(s.get('notes', noteIdFor('g4'))).toBeUndefined()

    const revs = s.all('revlog').sort((a, b) => a.time - b.time)
    expect(revs.map((r) => [r.rating, r.kind, r.from, r.ivl, r.lastIvl, r.taken])).toEqual([
      [3, 0, 'new', -60, 0, 5000],
      [4, 0, 'learn', 1, -60, 3000],
      [3, 1, 'review', 30, 10, 8000],
    ])
    expect(sum.skipped.join('\n')).toMatch(/1 manual reschedule/)
    expect(sum.skipped.join('\n')).toMatch(/1 reviews of cards that were not imported/)
    expect(sum.skipped.join('\n')).toMatch(/2 extra cards/)
    expect(sum.skipped.join('\n')).toMatch(/1 cloze cards/)
    expect(sum.skipped.join('\n')).toMatch(/1 empty notes/)
  })

  it('takes Anki’s scheduling on re-import only when Anki is further along', async () => {
    const s = mem()
    await importAnkiCollection(s, readAnkiPackage(legacyPackage(), SQL))
    const id = `${noteIdFor('g3')}.0`
    // studied in Ruled meanwhile
    s.put('cards', { ...s.get('cards', id)!, type: 2, queue: 2, reps: 3, ivl: 4, due: 99999 })
    const sum = await importAnkiCollection(s, readAnkiPackage(legacyPackage(), SQL))
    expect(s.get('cards', id)).toMatchObject({ reps: 3, ivl: 4 })
    expect(sum.cardsUpdated).toBe(0)
    // and the other way round
    s.put('cards', { ...s.get('cards', `${noteIdFor('g.1/x')}.0`)!, reps: 2 })
    const sum2 = await importAnkiCollection(s, readAnkiPackage(legacyPackage(), SQL))
    expect(sum2.cardsUpdated).toBe(1)
    expect(s.get('cards', `${noteIdFor('g.1/x')}.0`)).toMatchObject({ reps: 9, ivl: 30 })
  })
})

// ---------------------------------------------------------------- schema 18, zstd (collection.anki21b)

/** minimal protobuf writer for the test fixtures */
class PB {
  parts: number[] = []
  private varint(v: number) {
    while (v > 127) { this.parts.push((v & 127) | 128); v = Math.floor(v / 128) }
    this.parts.push(v)
  }
  int(f: number, v: number) { if (v) { this.varint(f * 8); this.varint(v) } return this }
  float(f: number, v: number) {
    this.varint(f * 8 + 5)
    const b = new Uint8Array(4)
    new DataView(b.buffer).setFloat32(0, v, true)
    this.parts.push(...b)
    return this
  }
  bytes(f: number, b: Uint8Array) { this.varint(f * 8 + 2); this.varint(b.length); this.parts.push(...b); return this }
  str(f: number, s: string) { return this.bytes(f, new TextEncoder().encode(s)) }
  packedFloats(f: number, vs: number[]) {
    const b = new Uint8Array(vs.length * 4)
    vs.forEach((v, i) => new DataView(b.buffer).setFloat32(i * 4, v, true))
    return this.bytes(f, b)
  }
  done() { return new Uint8Array(this.parts) }
}

function schema18Package(): Uint8Array {
  const db = new SQL.Database()
  db.run(SCHEMA11)
  db.run(`
    create table config (KEY text primary key, usn integer, mtime_secs integer, val blob);
    create table notetypes (id integer primary key, name text, mtime_secs integer, usn integer, config blob);
    create table fields (ntid integer, ord integer, name text, config blob, primary key (ntid, ord));
    create table templates (ntid integer, ord integer, name text, mtime_secs integer, usn integer, config blob, primary key (ntid, ord));
    create table decks (id integer primary key, name text, mtime_secs integer, usn integer, common blob, kind blob);
    create table deck_config (id integer primary key, name text, mtime_secs integer, usn integer, config blob);
  `)
  db.run('insert into col values (1,?,0,0,18,0,0,0,"","","","","")', [CRT])
  db.run('insert into config values ("schedVer",0,0,?)', [new TextEncoder().encode('2')])
  db.run('insert into notetypes values (1,"Cloze",0,0,?)', [new PB().int(1, 1).done()])
  db.run('insert into notetypes values (2,"Basic (and reversed card)",0,0,?)', [new PB().done()])
  for (const [nt, ord, name] of [[1, 0, 'Text'], [1, 1, 'Back Extra'], [2, 0, 'Front'], [2, 1, 'Back']] as const) db.run('insert into fields values (?,?,?,x\'\')', [nt, ord, name])
  db.run('insert into templates values (1,0,"Cloze",0,0,?)', [new PB().str(1, '{{cloze:Text}}').str(2, '{{cloze:Text}}<br>{{Back Extra}}').done()])
  db.run('insert into templates values (2,0,"Card 1",0,0,?)', [new PB().str(1, '{{Front}}').str(2, '{{Back}}').done()])
  db.run('insert into templates values (2,1,"Card 2",0,0,?)', [new PB().str(1, '{{Back}}').str(2, '{{Front}}').done()])
  const normal = (conf: number) => new PB().bytes(1, new PB().int(1, conf).done()).done()
  db.run('insert into decks values (1,"Default",0,0,x\'\',?)', [normal(1)])
  db.run('insert into decks values (5,?,0,0,x\'\',?)', ['Bio\x1fCells', normal(7)])
  db.run('insert into deck_config values (1,"Default",0,0,?)', [new PB().packedFloats(1, [1, 10]).packedFloats(2, [10]).int(9, 20).int(10, 200).float(11, 2.5).done()])
  db.run('insert into deck_config values (7,"Bio",0,0,?)', [
    new PB()
      .packedFloats(1, [0.5, 30, 1440]).packedFloats(2, []).int(9, 12).int(10, 300)
      .float(11, 2.7).float(12, 1.25).float(13, 1.15).float(14, 0.1).float(15, 0.95)
      .int(16, 2000).int(17, 2).int(18, 2).int(19, 7).int(21, 1).int(22, 10).int(30, 2)
      .done(),
  ])
  const day = Math.floor((Date.now() / 1000 - CRT) / 86400)
  insertNotes(
    db,
    [
      [5001, 'cl1', 1, ' bio::cells ', ['The {{c1::mitochondria}} is the {{c2::powerhouse}}', '<i>of the cell</i>']],
      [5002, 'rv1', 2, '', ['ATP', 'adenosine triphosphate [sound:atp.mp3]']],
    ],
    [
      { id: 6001, nid: 5001, did: 5, ord: 0, type: 2, queue: -1, due: day + 3, ivl: 12, factor: 2400, reps: 5 },
      { id: 6002, nid: 5001, did: 5, ord: 1, type: 3, queue: 1, due: 1_800_000_000, ivl: 2, factor: 2200, reps: 7, lapses: 2, left: 1 },
      { id: 6003, nid: 5002, did: 5, ord: 0, type: 2, queue: 2, due: day, ivl: 9, factor: 2500, reps: 4 },
      { id: 6004, nid: 5002, did: 5, ord: 1, type: 0, queue: 0, due: 2 },
    ],
    [[1_700_000_000_000, 6002, 1, -600, 2, 2200, 6000, 1], [1_700_000_001_000, 6002, 3, -1200, -600, 2200, 3000, 2]],
  )
  const bytes = db.export()
  db.close()
  return zipSync({
    'collection.anki21b': new Uint8Array(zstdCompressSync(bytes)),
    'collection.anki2': new Uint8Array(10), // newer packages carry a dummy legacy collection too
    media: new Uint8Array(zstdCompressSync(new PB().done())),
  })
}

describe('schema 18 (collection.anki21b, zstd)', () => {
  it('decodes protobuf configs, notetypes and \\x1f deck names', async () => {
    const col = readAnkiPackage(schema18Package(), SQL)
    expect(col.source).toBe('collection.anki21b')
    expect(col.schema).toBe(18)
    const s = mem()
    const sum = await importAnkiCollection(s, col)
    expect(s.all('decks').map((d) => d.name)).toEqual(['Bio::Cells'])
    expect(s.all('decks')[0].config).toEqual({
      newPerDay: 12, reviewsPerDay: 300, learnSteps: [0.5, 30, 1440], relearnSteps: [], initialEase: 2.7, easyBonus: 1.25, hardFactor: 1.15,
      lapseMult: 0.1, ivlModifier: 0.95, maxIvl: 2000, minLapseIvl: 2, graduatingIvl: 2, easyIvl: 7, leechAction: 'tag', leechThreshold: 10, newMix: 'before',
    })
    const cl = s.get('notes', noteIdFor('cl1'))!
    expect(cl).toMatchObject({ kind: 'cloze', tags: ['bio::cells'], fields: { extra: '<i>of the cell</i>' } })
    const day = Math.floor((Date.now() / 1000 - CRT) / 86400)
    expect(s.get('cards', `${cl.id}.1`)).toMatchObject({ suspended: true, queue: 2, type: 2, due: OFF + day + 3 })
    expect(s.get('cards', `${cl.id}.2`)).toMatchObject({ type: 3, queue: 1, due: 1_800_000_000, left: 1, stepSecs: 1200 })
    const rv = s.get('notes', noteIdFor('rv1'))!
    expect(rv).toMatchObject({ kind: 'reversed', fields: { front: 'ATP', back: 'adenosine triphosphate' } })
    // a review due "today" in Anki is due today in Ruled
    expect(s.get('cards', `${rv.id}.0`)!.due).toBe(timing().today)
    expect(buildQueue(s, s.all('decks')[0].id).counts.review).toBe(1)
    expect(s.all('revlog').map((r) => [r.rating, r.kind])).toEqual([[1, 1], [3, 2]])
    expect(sum).toMatchObject({ notesAdded: 2, cardsAdded: 4, reviewsAdded: 2 })
  })
})

it('rejects files that are not Anki packages', () => {
  expect(() => readAnkiPackage(new TextEncoder().encode('hello'), SQL)).toThrow(/Not an Anki package/)
  expect(() => readAnkiPackage(zipSync({ 'x.txt': new Uint8Array(1) }), SQL)).toThrow(/No Anki collection/)
})
