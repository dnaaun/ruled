import { type DeckConfig, type Card, type Deck, type Note, type NoteKind, type Revlog, DEFAULT_CONFIG } from './model'
import { noteOrds } from './render'
import { type Rating, answerCard } from './scheduler/answer'
import { dayNumber, type Timing, timing } from './scheduler/timing'
import { type Store, randomId } from './store'

export const PALETTE = [0, 1, 2, 3, 4, 5]

export function deckConfig(s: Store, deckId: string): DeckConfig {
  const d = s.get('decks', deckId)
  return { ...DEFAULT_CONFIG, ...(d?.config ?? {}) }
}

export function createDeck(s: Store, name: string): Deck {
  const existing = s.all('decks').length
  return s.put('decks', {
    id: randomId(),
    name: name.trim() || 'Untitled',
    created: Date.now(),
    config: { ...DEFAULT_CONFIG },
    color: existing % PALETTE.length,
  })
}

export function updateDeck(s: Store, id: string, patch: Partial<Deck>) {
  const d = s.get('decks', id)
  if (!d) return
  s.put('decks', { ...d, ...patch, id })
}

export function deleteDeck(s: Store, id: string) {
  s.batch(() => {
    for (const n of s.all('notes')) if (n.deckId === id) deleteNote(s, n.id)
    s.remove('decks', id)
  })
}

function newCard(note: Note, ord: number): Omit<Card, 'hlc' | 'seq'> {
  return {
    // deterministic id: two devices editing the same note never create duplicate cards
    id: `${note.id}.${ord}`,
    noteId: note.id,
    deckId: note.deckId,
    ord,
    type: 0,
    queue: 0,
    due: note.created + ord,
    ivl: 0,
    factor: 0,
    reps: 0,
    lapses: 0,
    left: 0,
    stepSecs: 0,
    created: Date.now(),
  }
}

export function cardsOf(s: Store, noteId: string): Card[] {
  return s.all('cards').filter((c) => c.noteId === noteId)
}

export function addNote(s: Store, deckId: string, kind: NoteKind, fields: Record<string, string>, tags: string[] = []): Note {
  let note!: Note
  s.batch(() => {
    const now = Date.now()
    note = s.put('notes', { id: randomId(), deckId, kind, fields, tags, created: now, mod: now })
    for (const ord of noteOrds(note)) s.put('cards', newCard(note, ord))
  })
  return note
}

export function updateNote(s: Store, id: string, patch: Partial<Pick<Note, 'fields' | 'tags' | 'deckId' | 'kind'>>) {
  const prev = s.get('notes', id)
  if (!prev) return
  s.batch(() => {
    const note = s.put('notes', { ...prev, ...patch, id, mod: Date.now() })
    const want = new Set(noteOrds(note))
    for (const c of cardsOf(s, id)) {
      if (!want.has(c.ord)) s.remove('cards', c.id)
      else {
        want.delete(c.ord)
        if (c.deckId !== note.deckId) s.put('cards', { ...c, deckId: note.deckId })
      }
    }
    for (const ord of want) {
      // a card that existed before (tombstoned) comes back as new
      s.put('cards', newCard(note, ord))
    }
  })
}

export function deleteNote(s: Store, id: string) {
  s.batch(() => {
    for (const c of cardsOf(s, id)) s.remove('cards', c.id)
    s.remove('notes', id)
  })
}

export function setSuspended(s: Store, cardId: string, suspended: boolean) {
  const c = s.get('cards', cardId)
  if (c) s.put('cards', { ...c, suspended })
}

export function buryCard(s: Store, cardId: string) {
  const c = s.get('cards', cardId)
  if (c) s.put('cards', { ...c, buriedUntil: timing().today + 1 })
}

/** Anki's "Forget": reset to new, keep at end of new queue. */
export function forgetCard(s: Store, cardId: string) {
  const c = s.get('cards', cardId)
  if (!c) return
  s.put('cards', {
    ...c,
    type: 0,
    queue: 0,
    due: Date.now(),
    ivl: 0,
    factor: 0,
    left: 0,
    stepSecs: 0,
    reps: 0,
    lapses: 0,
    buriedUntil: undefined,
  })
}

// ---------------------------------------------------------------- answering + undo

export interface UndoEntry { card: Card; note?: Note; revlogId: string }

export function answer(s: Store, cardId: string, rating: Rating, takenMs: number, t: Timing = timing()): UndoEntry | null {
  const card = s.get('cards', cardId)
  if (!card) return null
  const cfg = deckConfig(s, card.deckId)
  const res = answerCard(card, cfg, rating, t, takenMs)
  const revlogId = `${t.now * 1000}${randomId(4)}`
  const undo: UndoEntry = { card, revlogId }
  s.batch(() => {
    s.put('cards', res.card)
    s.put('revlog', { id: revlogId, ...res.revlog })
    if (res.leeched) {
      const note = s.get('notes', card.noteId)
      if (note && !note.tags.includes('leech')) {
        undo.note = note
        s.put('notes', { ...note, tags: [...note.tags, 'leech'] })
      }
    }
  })
  return undo
}

export function undoAnswer(s: Store, u: UndoEntry) {
  s.batch(() => {
    s.put('cards', u.card)
    if (u.note) s.put('notes', u.note)
    s.remove('revlog', u.revlogId)
  })
}

// ---------------------------------------------------------------- study queue (Anki v3, simplified)

export interface DeckCounts { new: number; learn: number; review: number; total: number }

export interface QueueSnapshot {
  main: string[]
  counts: DeckCounts
}

function hash(str: string): number {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619)
  return h >>> 0
}

export function todayCounts(s: Store, deckId: string, t: Timing) {
  let newDone = 0
  let reviewsDone = 0
  for (const r of s.all('revlog')) {
    if (r.deckId !== deckId || dayNumber(r.time) !== t.today) continue
    if (r.from === 'new') newDone++
    else if (r.from === 'review') reviewsDone++
  }
  return { newDone, reviewsDone }
}

function available(c: Card, t: Timing) {
  return !c.suspended && !(c.buriedUntil && c.buriedUntil > t.today)
}

export function buildQueue(s: Store, deckId: string, t: Timing = timing()): QueueSnapshot {
  const cfg = deckConfig(s, deckId)
  const cards = s.all('cards').filter((c) => c.deckId === deckId && available(c, t))
  const { newDone, reviewsDone } = todayCounts(s, deckId, t)

  const reviewLimit = Math.max(0, cfg.reviewsPerDay - reviewsDone)
  // v3: interday learning + reviews, "due date, then random"
  const due = cards
    .filter((c) => (c.queue === 2 || c.queue === 3) && c.due <= t.today)
    .sort((a, b) => a.due - b.due || hash(a.id + t.today) - hash(b.id + t.today))
    .slice(0, reviewLimit)
  // v3: the review limit also caps new cards
  const newLimit = Math.max(0, Math.min(cfg.newPerDay - newDone, reviewLimit - due.length))
  const fresh = cards
    .filter((c) => c.queue === 0)
    .sort((a, b) => a.due - b.due || a.ord - b.ord)
    .slice(0, newLimit)

  let main: Card[]
  if (cfg.newMix === 'before') main = [...fresh, ...due]
  else if (cfg.newMix === 'after') main = [...due, ...fresh]
  else main = intersperse(due, fresh)

  const learnCutoff = t.now + 20 * 60
  const intraday = cards.filter((c) => c.queue === 1 && c.due <= learnCutoff).length
  const interday = due.filter((c) => c.queue === 3).length
  return {
    main: main.map((c) => c.id),
    counts: {
      new: fresh.length,
      learn: intraday + interday,
      review: due.length - interday,
      total: cards.length,
    },
  }
}

/** Spread b evenly through a (Anki's Intersperser). */
export function intersperse<T>(a: T[], b: T[]): T[] {
  if (!b.length) return a
  if (!a.length) return b
  const out: T[] = []
  const ratio = (a.length + 1) / (b.length + 1)
  let ai = 0
  for (let bi = 0; bi < b.length; bi++) {
    const target = Math.floor(ratio * (bi + 1))
    while (ai < target && ai < a.length) out.push(a[ai++])
    out.push(b[bi])
  }
  while (ai < a.length) out.push(a[ai++])
  return out
}

/**
 * Pick the next card to show. Learning cards that are due take priority (Anki shows them the
 * moment they come due); then the main queue; then learning cards within the learn-ahead limit.
 */
export function nextCard(s: Store, deckId: string, main: string[], t: Timing = timing()): Card | null {
  const learning = s
    .all('cards')
    .filter((c) => c.deckId === deckId && c.queue === 1 && available(c, t))
    .sort((a, b) => a.due - b.due)
  if (learning[0] && learning[0].due <= t.now) return learning[0]
  for (const id of main) {
    const c = s.get('cards', id)
    if (c && available(c, t) && c.deckId === deckId && (c.queue === 0 || ((c.queue === 2 || c.queue === 3) && c.due <= t.today))) return c
  }
  if (learning[0] && learning[0].due <= t.now + 20 * 60) return learning[0]
  return null
}

/** Live counts while studying. */
export function liveCounts(s: Store, deckId: string, main: string[], t: Timing = timing()): DeckCounts {
  let n = 0
  let r = 0
  let l = 0
  for (const id of main) {
    const c = s.get('cards', id)
    if (!c || !available(c, t)) continue
    if (c.queue === 0) n++
    else if (c.queue === 2 && c.due <= t.today) r++
    else if (c.queue === 3 && c.due <= t.today) l++
  }
  for (const c of s.all('cards')) if (c.deckId === deckId && c.queue === 1 && available(c, t) && c.due <= t.now + 20 * 60) l++
  return { new: n, learn: l, review: r, total: 0 }
}

/** When does the next learning card come due (for the "come back in…" screen)? */
export function nextLearningDue(s: Store, deckId: string): number | null {
  let min: number | null = null
  for (const c of s.all('cards')) if (c.deckId === deckId && c.queue === 1 && !c.suspended && (min == null || c.due < min)) min = c.due
  return min
}

// ---------------------------------------------------------------- import

export function parseDelimited(text: string): { rows: string[][]; sep: string } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let sep = ''
  const body: string[] = []
  for (const line of lines) {
    const m = line.match(/^#separator:(\w+)/i)
    if (m) {
      const v = m[1].toLowerCase()
      sep = v === 'tab' ? '\t' : v === 'comma' ? ',' : v === 'semicolon' ? ';' : v === 'pipe' ? '|' : sep
      continue
    }
    if (line.startsWith('#')) continue
    if (line.trim()) body.push(line)
  }
  if (!sep) {
    const sample = body.slice(0, 20).join('\n')
    sep = [...['\t', ';', ',', '|']].sort((a, b) => sample.split(b).length - sample.split(a).length)[0]
  }
  const rows = body.map((line) => splitRow(line, sep))
  return { rows, sep }
}

function splitRow(line: string, sep: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') q = false
      else cur += ch
    } else if (ch === '"' && cur === '') q = true
    else if (ch === sep) { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out.map((x) => x.replace(/<br\s*\/?>/gi, '\n').trim())
}

export function importRows(s: Store, deckId: string, rows: string[][], kind: NoteKind): number {
  let n = 0
  s.batch(() => {
    for (const r of rows) {
      if (!r[0]) continue
      const tags = (r[2] ?? '').split(/\s+/).filter(Boolean)
      if (kind === 'cloze') addNote(s, deckId, 'cloze', { text: r[0], extra: r[1] ?? '' }, tags)
      else addNote(s, deckId, kind, { front: r[0], back: r[1] ?? '' }, tags)
      n++
    }
  })
  return n
}

export function revlogFor(s: Store, cardId: string): Revlog[] {
  return s.all('revlog').filter((r) => r.cardId === cardId).sort((a, b) => a.time - b.time)
}
