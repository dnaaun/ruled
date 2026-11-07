import { useState } from 'preact/hooks'
import { Icon, plural, useStore } from '../components/ui'
import type { Card } from '../lib/model'
import { notePrimary, noteSecondary } from '../lib/render'
import { timing } from '../lib/scheduler/timing'

type Filter = 'all' | 'new' | 'learning' | 'due' | 'review' | 'suspended' | 'leech'

function stateOf(cards: Card[], today: number): [string, string] {
  if (!cards.length) return ['—', 'var(--ink-3)']
  if (cards.every((c) => c.suspended)) return ['suspended', 'var(--ink-3)']
  const live = cards.filter((c) => !c.suspended)
  if (live.some((c) => c.type === 1 || c.type === 3)) return ['learning', 'var(--learn)']
  const rev = live.filter((c) => c.type === 2)
  if (rev.length) {
    const next = Math.min(...rev.map((c) => c.due))
    if (next <= today) return ['due', 'var(--review)']
    const d = next - today
    return [d < 30 ? `in ${d}d` : d < 365 ? `in ${Math.round(d / 30)}mo` : `in ${(d / 365).toFixed(1)}y`, 'var(--ink-2)']
  }
  return ['new', 'var(--new)']
}

export function Browse({ deckId }: { deckId?: string }) {
  const s = useStore()
  const [q, setQ] = useState('')
  const [deck, setDeck] = useState(deckId ?? '')
  const [filter, setFilter] = useState<Filter>('all')
  const [limit, setLimit] = useState(150)
  const t = timing()
  const decks = s.all('decks').sort((a, b) => a.name.localeCompare(b.name))
  const deckName = new Map(decks.map((d) => [d.id, d.name]))
  const cardsByNote = new Map<string, Card[]>()
  for (const c of s.all('cards')) {
    const a = cardsByNote.get(c.noteId)
    a ? a.push(c) : cardsByNote.set(c.noteId, [c])
  }
  const needle = q.trim().toLowerCase()
  const tagNeedle = needle.startsWith('#') || needle.startsWith('tag:') ? needle.replace(/^(#|tag:)/, '') : null
  const notes = s
    .all('notes')
    .filter((n) => !deck || n.deckId === deck)
    .filter((n) => {
      if (!needle) return true
      if (tagNeedle != null) return n.tags.some((x) => x.toLowerCase().startsWith(tagNeedle))
      return Object.values(n.fields).some((v) => v.toLowerCase().includes(needle)) || n.tags.some((x) => x.toLowerCase() === needle)
    })
    .filter((n) => {
      if (filter === 'all') return true
      const cs = cardsByNote.get(n.id) ?? []
      switch (filter) {
        case 'new': return cs.some((c) => c.type === 0 && !c.suspended)
        case 'learning': return cs.some((c) => (c.type === 1 || c.type === 3) && !c.suspended)
        case 'review': return cs.some((c) => c.type === 2 && !c.suspended)
        case 'due': return cs.some((c) => !c.suspended && ((c.queue === 2 || c.queue === 3) ? c.due <= t.today : c.queue === 1))
        case 'suspended': return cs.some((c) => c.suspended)
        case 'leech': return n.tags.includes('leech')
      }
    })
    .sort((a, b) => b.created - a.created)

  return (
    <main class="page">
      <p class="eyebrow">Browse</p>
      <h1 class="display" style={{ fontSize: 'clamp(32px, 5vw, 46px)' }}>The <em>card catalogue</em>.</h1>
      <div class="filters" style={{ marginTop: '24px' }}>
        <input class="input" placeholder="Search text, or #tag" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
        <select class="select" value={deck} onChange={(e) => setDeck(e.currentTarget.value)}>
          <option value="">All stacks</option>
          {decks.map((d) => <option value={d.id}>{d.name}</option>)}
        </select>
        <select class="select" value={filter} onChange={(e) => setFilter(e.currentTarget.value as Filter)}>
          <option value="all">Any state</option>
          <option value="due">Due now</option>
          <option value="new">New</option>
          <option value="learning">Learning</option>
          <option value="review">In review</option>
          <option value="suspended">Suspended</option>
          <option value="leech">Leeches</option>
        </select>
      </div>
      <div class="row" style={{ justifyContent: 'space-between', marginBottom: '10px' }}>
        <span class="mono small muted">{plural(notes.length, 'note')}</span>
        {deck && <a class="btn ghost" href={`#/add/${deck}`}><Icon.plus /> Add</a>}
      </div>
      {notes.length === 0 ? (
        <div class="empty paper"><h3>No cards match.</h3><p>Try a different search or stack.</p></div>
      ) : (
        <div class="list paper">
          {notes.slice(0, limit).map((n) => {
            const [label, col] = stateOf(cardsByNote.get(n.id) ?? [], t.today)
            return (
              <a class="item" href={`#/edit/${n.id}`} key={n.id}>
                <span class="q">{notePrimary(n) || <span class="muted">(empty)</span>}</span>
                <span class="a">{noteSecondary(n)}</span>
                <span class="d">{deckName.get(n.deckId) ?? '—'}{n.tags.length ? ` · #${n.tags.join(' #')}` : ''}</span>
                <span class="pill" style={{ '--c': col } as any}>{label}</span>
              </a>
            )
          })}
        </div>
      )}
      {notes.length > limit && (
        <div class="row" style={{ justifyContent: 'center', marginTop: '18px' }}>
          <button class="btn" onClick={() => setLimit(limit + 300)}>Show more</button>
        </div>
      )}
    </main>
  )
}
