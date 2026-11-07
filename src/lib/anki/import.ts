// Mapping an Anki collection onto Ruled records, and writing them through the Store (so every record
// gets an HLC stamp and syncs). Importing the same package twice merges: ids are derived from Anki's
// note guids, so nothing is duplicated.

import { type Card, type CardQueue, type CardType, type Deck, type DeckConfig, DEFAULT_CONFIG, type Note, type NoteKind, type Revlog } from '../model'
import { PALETTE } from '../ops'
import { noteOrds } from '../render'
import { dayNumber } from '../scheduler/timing'
import type { Draft, Store } from '../store'
import type { AnkiCard, AnkiCollection, AnkiNote, AnkiNotetype, AnkiRevlog } from './package'

export interface ImportOptions {
  /** largest image embedded into a note, in bytes */
  maxImageBytes?: number
  /** total bytes of images embedded across the whole import */
  imageBudget?: number
  onProgress?: (p: ImportProgress) => void
}
export interface ImportProgress { phase: 'convert' | 'write'; done: number; total: number }

export interface ImportSummary {
  decks: { id: string; name: string; cards: number; created: boolean }[]
  notesAdded: number
  notesUpdated: number
  notesUnchanged: number
  cardsAdded: number
  cardsUpdated: number
  cardsUnchanged: number
  reviewsAdded: number
  reviewsExisting: number
  /** human-readable notes about anything that couldn't be carried over */
  skipped: string[]
  imagesEmbedded: number
  imagesDropped: number
}

// ---------------------------------------------------------------- ids

/** Anki guids are short base91 strings that can contain '.', which Ruled uses in card ids; hex keeps it reversible and safe. */
export function noteIdFor(guid: string): string {
  let hex = ''
  for (const b of new TextEncoder().encode(guid)) hex += b.toString(16).padStart(2, '0')
  return `anki${hex}`
}

function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/** Same Anki deck name → same Ruled deck, on every device and every re-import. */
export const deckIdFor = (name: string) => `anki${cyrb53(name).toString(36)}`
export const revlogIdFor = (r: AnkiRevlog) => `anki${r.id}.${r.cid.toString(36)}`

// ---------------------------------------------------------------- fields

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
}
const IMG_RE = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi
const SOUND_RE = /\[sound:[^\]]*\]/g

const unescapeHtml = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (_m, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" })[e]!)
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export function imageNames(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(IMG_RE)) {
    const src = unescapeHtml(m[1] ?? m[2] ?? m[3] ?? '')
    if (src && !/^(https?:|data:)/i.test(src)) out.push(safeDecode(src))
  }
  return out
}
const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** Turns an Anki field (HTML) into a Ruled field: sounds removed, images embedded as data: URLs or replaced by a placeholder. */
export function convertField(html: string, images: Map<string, string>): string {
  return html
    .replace(SOUND_RE, '')
    .replace(IMG_RE, (tag, a?: string, b?: string, c?: string) => {
      const src = unescapeHtml(a ?? b ?? c ?? '')
      if (/^(https?:|data:)/i.test(src)) return tag
      const name = safeDecode(src)
      const url = images.get(name)
      if (url) return `<img src="${url}" alt="${escapeHtml(name)}">`
      return `<span class="media-missing" title="Image not imported">[image: ${escapeHtml(name)}]</span>`
    })
    .trim()
}

// ---------------------------------------------------------------- notetypes

/** Anki's standard "Basic (and reversed card)" / "Basic (optional reversed card)" shape. */
function isReversedType(nt: AnkiNotetype): boolean {
  if (nt.cloze || nt.templates.length !== 2 || nt.fields.length < 2) return false
  const refs = (fmt: string, field: string) => fmt.includes(`${field}}}`)
  const [a, b] = nt.templates
  return refs(a.qfmt, nt.fields[0]) && refs(b.qfmt, nt.fields[1])
}

const hasText = (f: string) => !!f.replace(/<[^>]*>|&nbsp;|\s/g, '') || /<img\b/i.test(f)
const joinRest = (fields: string[]) => fields.filter(hasText).join('\n\n')
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Fields the templates actually display — `{{Name}}`, `{{text:Name}}`… but not `{{#Name}}` conditionals like "Add Reverse". */
function displayedFields(nt: AnkiNotetype): Set<number> {
  const all = nt.templates.map((t) => t.qfmt + t.afmt).join('\n')
  const shown = new Set<number>()
  nt.fields.forEach((name, i) => {
    if (new RegExp(`\\{\\{(?:[^#/^}]*:)?${escapeRe(name)}\\}\\}`).test(all)) shown.add(i)
  })
  return shown
}

/** Fields from index `from` on, keeping only displayed ones (unless the templates display none past the first). */
function restFields(nt: AnkiNotetype, f: string[], from = 1): string[] {
  const shown = displayedFields(nt)
  const any = [...shown].some((i) => i >= 1)
  return f.filter((_x, i) => i >= from && (!any || shown.has(i)))
}

// ---------------------------------------------------------------- scheduling

/** Ruled day number of Anki's day 0 (collection creation date, local time — as rslib's sched_timing_today). */
export function dayOffset(crt: number): number {
  return dayNumber(crt * 1000, 0)
}

function restoreQueue(type: number, due: number): CardQueue {
  if (type === 0) return 0
  if (type === 2) return 2
  // learning / relearning: intraday ones are due at an epoch timestamp, interday ones on a day number
  return due > 1_000_000_000 ? 1 : 3
}

export function mapScheduling(
  ac: AnkiCard,
  cfg: DeckConfig,
  offset: number,
  lastLearnSecs: number | undefined,
): Pick<Card, 'type' | 'queue' | 'due' | 'ivl' | 'factor' | 'reps' | 'lapses' | 'left' | 'stepSecs' | 'suspended'> {
  const type = (ac.type >= 0 && ac.type <= 3 ? ac.type : 0) as CardType
  // cards sitting in a filtered deck keep their real due date in odue
  let due = ac.odid && ac.odue ? ac.odue : ac.due
  let queue: CardQueue
  if (ac.queue >= 0 && ac.queue <= 3 && !(ac.odid && ac.odue)) queue = ac.queue as CardQueue
  else queue = restoreQueue(type, due) // suspended (-1), buried (-2/-3), preview (4), filtered
  if (type === 0) queue = 0
  if (type === 2 && queue !== 2) queue = 2
  if (queue === 2 || queue === 3) due = offset + due
  const left = type === 1 || type === 3 ? Math.max(1, ac.left % 1000) : 0
  const steps = type === 3 ? cfg.relearnSteps : cfg.learnSteps
  const stepSecs =
    type === 1 || type === 3
      ? lastLearnSecs ?? Math.round((steps[Math.max(0, steps.length - left)] ?? steps[0] ?? 1) * 60)
      : 0
  let factor = ac.factor
  if ((type === 2 || type === 3) && factor < 1300) factor = Math.round(cfg.initialEase * 1000)
  return {
    type,
    queue,
    due,
    ivl: Math.max(0, ac.ivl),
    factor,
    reps: ac.reps,
    lapses: ac.lapses,
    left,
    stepSecs,
    suspended: ac.queue === -1 ? true : undefined,
  }
}

export function mapRevlog(r: AnkiRevlog, schedVer: number): Pick<Revlog, 'rating' | 'kind' | 'from' | 'ivl' | 'lastIvl' | 'factor' | 'taken' | 'time'> | null {
  // 0 learn, 1 review, 2 relearn, 3 filtered (early review / cram), 4 manual, 5 rescheduled
  if (r.ease < 1 || r.ease > 4 || r.type > 3 || r.type < 0) return null
  let rating = r.ease
  // the v1 scheduler gave learning cards three buttons: again / good / easy
  if (schedVer === 1 && (r.type === 0 || r.type === 2) && rating >= 2) rating = Math.min(4, rating + 1)
  const kind = (r.type === 3 ? 1 : r.type) as 0 | 1 | 2
  const from: Revlog['from'] = kind === 1 ? 'review' : kind === 0 && r.lastIvl === 0 ? 'new' : 'learn'
  return { rating: rating as Revlog['rating'], kind, from, ivl: r.ivl, lastIvl: r.lastIvl, factor: r.factor, taken: Math.max(0, r.time), time: r.id }
}

// ---------------------------------------------------------------- import

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

export async function importAnkiCollection(s: Store, col: AnkiCollection, opts: ImportOptions = {}): Promise<ImportSummary> {
  const maxImage = opts.maxImageBytes ?? 300_000
  let budget = opts.imageBudget ?? 25_000_000
  const progress = opts.onProgress ?? (() => {})
  const offset = dayOffset(col.crt)
  const sum: ImportSummary = {
    decks: [], notesAdded: 0, notesUpdated: 0, notesUnchanged: 0, cardsAdded: 0, cardsUpdated: 0, cardsUnchanged: 0,
    reviewsAdded: 0, reviewsExisting: 0, skipped: [], imagesEmbedded: 0, imagesDropped: 0,
  }
  const skip = new Map<string, number>()
  const skipped = (why: string, n = 1) => skip.set(why, (skip.get(why) ?? 0) + n)

  const cardsByNote = new Map<number, AnkiCard[]>()
  for (const c of col.cards) {
    const list = cardsByNote.get(c.nid)
    if (list) list.push(c)
    else cardsByNote.set(c.nid, [c])
  }
  const lastLearn = new Map<number, number>()
  for (const r of col.revlog) if (r.ivl < 0) lastLearn.set(r.cid, -r.ivl)

  const realDeck = (c: AnkiCard) => (c.odid ? c.odid : c.did)
  const deckName = (did: number) => {
    const d = col.decks.get(did)
    return d && !d.filtered ? d.name : 'Anki import'
  }
  const cfgFor = (did: number): DeckConfig => {
    const d = col.decks.get(did)
    const legacyMix: DeckConfig['newMix'] = col.newSpread === 1 ? 'after' : col.newSpread === 2 ? 'before' : 'mix'
    return { ...DEFAULT_CONFIG, newMix: legacyMix, ...(d ? col.configs.get(d.confId) ?? col.configs.get(1) : col.configs.get(1)) }
  }

  // ---- images: collect names first, then pull just those files out of the zip
  const uses = new Map<string, number>()
  for (const n of col.notes) for (const f of n.fields) for (const name of imageNames(f)) uses.set(name, (uses.get(name) ?? 0) + 1)
  const images = new Map<string, string>()
  if (uses.size) {
    const files = col.media([...uses.keys()])
    // smallest first, so a few huge images don't crowd out many small ones
    for (const [name, bytes] of [...files].sort((a, b) => a[1].length - b[1].length)) {
      const mime = MIME[name.split('.').pop()?.toLowerCase() ?? '']
      // every note that uses an image gets its own copy, so charge the budget per use
      const cost = bytes.length * (uses.get(name) ?? 1)
      if (!mime || bytes.length > maxImage || cost > budget) continue
      budget -= cost
      images.set(name, `data:${mime};base64,${toBase64(bytes)}`)
    }
  }

  // ---- convert
  type Planned = { note: Draft<'notes'>; cards: Draft<'cards'>[]; ankiCards: Map<string, AnkiCard> }
  const planned: Planned[] = []
  const deckCards = new Map<string, { name: string; cfg: DeckConfig; cards: number }>()
  let done = 0
  for (const an of col.notes) {
    if (++done % 500 === 0) {
      progress({ phase: 'convert', done, total: col.notes.length })
      await tick()
    }
    const nt = col.notetypes.get(an.mid)
    const acards = (cardsByNote.get(an.id) ?? []).sort((a, b) => a.ord - b.ord)
    if (!nt) { skipped('notes with an unknown note type'); continue }
    if (!acards.length) { skipped('notes without cards'); continue }
    const plan = planNote(an, nt, acards, images)
    if (!plan) { skipped('empty notes'); continue }
    for (const name of an.fields.flatMap(imageNames)) {
      if (images.has(name)) sum.imagesEmbedded++
      else sum.imagesDropped++
    }
    if (plan.extraCards) skipped('extra cards from note types with more than two templates (only the first is kept)', plan.extraCards)

    const homeDid = realDeck(acards[0])
    const name = deckName(homeDid)
    const deckId = deckIdFor(name)
    const cfg = cfgFor(homeDid)
    const noteId = noteIdFor(an.guid)
    const note: Draft<'notes'> = { id: noteId, deckId, kind: plan.kind, fields: plan.fields, tags: an.tags, created: an.id, mod: an.mod * 1000 }
    const ords = noteOrds(note)
    const byOrd = new Map(plan.cards.map((x) => [x.ord, x.card]))
    const cards: Draft<'cards'>[] = []
    const ankiCards = new Map<string, AnkiCard>()
    for (const ord of ords) {
      const ac = byOrd.get(ord)
      const id = `${noteId}.${ord}`
      if (ac) {
        ankiCards.set(id, ac)
        cards.push({ id, noteId, deckId, ord, created: ac.id, ...mapScheduling(ac, cfg, offset, lastLearn.get(ac.id)) })
      } else {
        cards.push({ id, noteId, deckId, ord, type: 0, queue: 0, due: an.id + ord, ivl: 0, factor: 0, reps: 0, lapses: 0, left: 0, stepSecs: 0, created: Date.now() })
      }
    }
    const orphans = plan.cards.filter((x) => !ords.includes(x.ord)).length
    if (orphans) skipped('cloze cards whose cloze number is no longer in the text', orphans)
    planned.push({ note, cards, ankiCards })
    const dc = deckCards.get(deckId) ?? { name, cfg, cards: 0 }
    dc.cards += cards.length
    deckCards.set(deckId, dc)
  }

  // ---- write
  const cardIdFor = new Map<number, string>()
  for (const p of planned) for (const [id, ac] of p.ankiCards) cardIdFor.set(ac.id, id)
  const reviews: [AnkiRevlog, NonNullable<ReturnType<typeof mapRevlog>>][] = []
  for (const r of col.revlog) {
    if (!cardIdFor.has(r.cid)) { skipped('reviews of cards that were not imported'); continue }
    const m = mapRevlog(r, col.schedVer)
    if (!m) { skipped('manual reschedule / forget entries in the review history'); continue }
    reviews.push([r, m])
  }
  const total = deckCards.size + planned.length + reviews.length
  let written = 0
  const report = async () => {
    progress({ phase: 'write', done: written, total })
    await tick()
  }

  s.batch(() => {
    let color = s.all('decks').length
    for (const [id, d] of [...deckCards].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
      const existing = s.get('decks', id)
      if (!existing) {
        const deck: Draft<'decks'> = { id, name: d.name, created: Date.now(), config: d.cfg, color: color++ % PALETTE.length }
        s.put('decks', deck as Deck)
      }
      sum.decks.push({ id, name: existing?.name ?? d.name, cards: d.cards, created: !existing })
      written++
    }
  })

  const CHUNK = 400
  for (let i = 0; i < planned.length; i += CHUNK) {
    s.batch(() => {
      for (const p of planned.slice(i, i + CHUNK)) {
        written++
        const prev = s.get('notes', p.note.id)
        let deckId = p.note.deckId
        if (!prev) {
          s.put('notes', p.note as Note)
          sum.notesAdded++
        } else {
          deckId = prev.deckId // the user may have moved it
          if (p.note.mod > prev.mod) {
            s.put('notes', { ...prev, kind: p.note.kind, fields: p.note.fields, tags: p.note.tags, mod: p.note.mod })
            sum.notesUpdated++
          } else sum.notesUnchanged++
        }
        for (const c of p.cards) {
          const old = s.get('cards', c.id)
          if (!old) {
            s.put('cards', { ...c, deckId } as Card)
            sum.cardsAdded++
          } else if (p.ankiCards.has(c.id) && c.reps > old.reps) {
            // Anki is further along than what we have: take its scheduling
            s.put('cards', { ...old, ...c, id: old.id, deckId: old.deckId, created: old.created, buriedUntil: undefined })
            sum.cardsUpdated++
          } else sum.cardsUnchanged++
        }
      }
    })
    await report()
  }

  const RCHUNK = 2000
  for (let i = 0; i < reviews.length; i += RCHUNK) {
    s.batch(() => {
      for (const [r, m] of reviews.slice(i, i + RCHUNK)) {
        written++
        const id = revlogIdFor(r)
        if (s.get('revlog', id)) { sum.reviewsExisting++; continue }
        const cardId = cardIdFor.get(r.cid)!
        const deckId = s.get('cards', cardId)?.deckId ?? ''
        s.put('revlog', { id, cardId, deckId, ...m })
        sum.reviewsAdded++
      }
    })
    await report()
  }

  for (const [why, n] of skip) sum.skipped.push(`${n} ${why}`)
  if (sum.imagesDropped) sum.skipped.push(`${sum.imagesDropped} images too large or missing (shown as a placeholder)`)
  return sum
}

interface NotePlan { kind: NoteKind; fields: Record<string, string>; cards: { ord: number; card: AnkiCard }[]; extraCards: number }

function planNote(an: AnkiNote, nt: AnkiNotetype, acards: AnkiCard[], images: Map<string, string>): NotePlan | null {
  const f = an.fields.map((x) => convertField(x, images))
  if (!f.some(hasText)) return null
  if (nt.cloze) {
    // Anki's cloze card ord is (cloze number − 1); Ruled uses the cloze number
    return { kind: 'cloze', fields: { text: f[0] ?? '', extra: joinRest(restFields(nt, f)) }, cards: acards.map((card) => ({ ord: card.ord + 1, card })), extraCards: 0 }
  }
  if (isReversedType(nt) && acards.some((c) => c.ord === 1)) {
    return {
      kind: 'reversed',
      fields: { front: f[0] ?? '', back: joinRest([f[1] ?? '', ...restFields(nt, f, 2)]) },
      cards: acards.filter((c) => c.ord <= 1).map((card) => ({ ord: card.ord, card })),
      extraCards: 0,
    }
  }
  // everything else: one basic card, scheduled like the note's first card
  const first = acards.find((c) => c.ord === 0) ?? acards[0]
  const extra = isReversedType(nt) ? 0 : acards.length - 1
  return { kind: 'basic', fields: { front: f[0] ?? '', back: joinRest(restFields(nt, f)) }, cards: [{ ord: 0, card: first }], extraCards: extra }
}
