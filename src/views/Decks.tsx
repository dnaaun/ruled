import { useState } from 'preact/hooks'
import { go, Icon, plural, useStore, useTick } from '../components/ui'
import { buildQueue, createDeck } from '../lib/ops'
import { dayNumber, timing } from '../lib/scheduler/timing'
import type { Store } from '../lib/store'
import { seedSampleDeck } from '../lib/sample'
import { AnkiImportModal } from './AnkiImport'

export function streak(s: Store): number {
  const days = new Set(s.all('revlog').map((r) => dayNumber(r.time)))
  let d = timing().today
  if (!days.has(d)) d--
  let n = 0
  while (days.has(d)) {
    n++
    d--
  }
  return n
}

export function Decks() {
  const s = useStore()
  useTick(30_000)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [ankiOpen, setAnkiOpen] = useState(false)
  const decks = s.all('decks').sort((a, b) => a.name.localeCompare(b.name))
  const t = timing()
  const info = decks.map((d) => ({ d, q: buildQueue(s, d.id, t) }))
  const due = info.reduce((n, x) => n + x.q.counts.new + x.q.counts.learn + x.q.counts.review, 0)
  const reviewedToday = s.all('revlog').filter((r) => dayNumber(r.time) === t.today).length
  const st = streak(s)

  const submit = (e: Event) => {
    e.preventDefault()
    if (!name.trim()) return setNaming(false)
    const d = createDeck(s, name)
    setName('')
    setNaming(false)
    go(`deck/${d.id}`)
  }

  const hour = new Date().getHours()
  const greet = hour < 5 ? 'Late night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'

  return (
    <main class="page">
      <div class="hero">
        <div>
          <p class="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
          <h1 class="display">
            {greet}. {due ? <><em>{due}</em> {due === 1 ? 'card waits' : 'cards wait'}.</> : <>The desk is <em>clear</em>.</>}
          </h1>
          <div class="summary">
            <span><b>{reviewedToday}</b> studied today</span>
            <span><b>{st}</b>-day streak</span>
            <span><b>{s.all('cards').length}</b> cards in {plural(decks.length, 'stack')}</span>
          </div>
        </div>
      </div>

      {decks.length === 0 && (
        <div class="welcome paper ruled">
          <div>
            <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '27px', fontWeight: 500, margin: '0 0 var(--line)', lineHeight: 'var(--line)' }}>A fresh box of index cards.</h3>
            <p class="muted" style={{ margin: 0, maxWidth: '52ch', lineHeight: 'var(--line)' }}>
              Make a stack, write some cards, and Ruled will schedule them exactly the way Anki would. Everything lives on this device and syncs straight to your others.
            </p>
          </div>
          <div class="row">
            <button class="btn" onClick={() => go(`deck/${seedSampleDeck(s).id}`)}>Try a sample stack</button>
            <button class="btn" onClick={() => setAnkiOpen(true)}><Icon.upload /> Import from Anki</button>
            <button class="btn primary" onClick={() => setNaming(true)}><Icon.plus /> New stack</button>
          </div>
        </div>
      )}

      <h2 class="section">Stacks <small>{decks.length ? 'tap one to study' : ''}</small></h2>
      <div class="stacks">
        {info.map(({ d, q }) => {
          const c = q.counts
          return (
            <a class={`stack${c.total === 0 ? ' empty' : ''}`} href={`#/deck/${d.id}`} key={d.id} style={{ '--tab': `var(--tab-${d.color ?? 0})` } as any}>
              <div class="face paper ruled">
                <span class="tab" />
                <h3>{d.name}</h3>
                <div class="meta">
                  <div class="counts">
                    <span class={c.new ? 'c-new' : 'zero'}><b>{c.new}</b><i>new</i></span>
                    <span class={c.learn ? 'c-learn' : 'zero'}><b>{c.learn}</b><i>learn</i></span>
                    <span class={c.review ? 'c-review' : 'zero'}><b>{c.review}</b><i>due</i></span>
                  </div>
                  <span class="total">{plural(c.total, 'card')}</span>
                </div>
              </div>
            </a>
          )
        })}
        {naming ? (
          <form class="newstack" onSubmit={submit}>
            <div style={{ width: '100%' }}>
              <span class="lbl">Name your stack</span>
              <input
                class="input"
                style={{ marginTop: '12px' }}
                autoFocus
                value={name}
                placeholder="e.g. Organic chemistry"
                onInput={(e) => setName(e.currentTarget.value)}
                onBlur={() => !name.trim() && setNaming(false)}
                onKeyDown={(e) => e.key === 'Escape' && setNaming(false)}
              />
              <div class="row" style={{ justifyContent: 'center', marginTop: '12px' }}>
                <button class="btn primary" type="submit">Create</button>
              </div>
            </div>
          </form>
        ) : (
          <button class="newstack" onClick={() => setNaming(true)}>
            <span>
              <span class="plus">+</span>
              <span class="lbl">New stack</span>
            </span>
          </button>
        )}
      </div>
      {decks.length > 0 && (
        <div class="toolrow">
          <button class="btn ghost" onClick={() => setAnkiOpen(true)}><Icon.upload /> Import from Anki</button>
        </div>
      )}
      {ankiOpen && <AnkiImportModal onClose={() => setAnkiOpen(false)} />}
    </main>
  )
}
