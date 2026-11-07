import { useState } from 'preact/hooks'
import { useStore } from '../components/ui'
import { dayNumber, dayStartMs, timing } from '../lib/scheduler/timing'
import { streak } from './Decks'

export function Stats({ deckId }: { deckId?: string }) {
  const s = useStore()
  const [deck, setDeck] = useState(deckId ?? '')
  const t = timing()
  const decks = s.all('decks').sort((a, b) => a.name.localeCompare(b.name))
  const revlog = s.all('revlog').filter((r) => !deck || r.deckId === deck)
  const cards = s.all('cards').filter((c) => !deck || c.deckId === deck)

  const perDay = new Map<number, number>()
  const timePerDay = new Map<number, number>()
  for (const r of revlog) {
    const d = dayNumber(r.time)
    perDay.set(d, (perDay.get(d) ?? 0) + 1)
    timePerDay.set(d, (timePerDay.get(d) ?? 0) + r.taken)
  }
  const today = perDay.get(t.today) ?? 0
  const todayMin = Math.round((timePerDay.get(t.today) ?? 0) / 60000)

  // true retention: review-card answers in the last 30 days that weren't "Again"
  const recent = revlog.filter((r) => r.kind === 1 && dayNumber(r.time) > t.today - 30)
  const retention = recent.length ? Math.round((recent.filter((r) => r.rating > 1).length / recent.length) * 1000) / 10 : null
  const mature = cards.filter((c) => c.type === 2 && c.ivl >= 21).length

  // heatmap: last 26 weeks, aligned to weeks (Mon first)
  const weeks = 53
  const startDow = (new Date(dayStartMs(t.today)).getDay() + 6) % 7
  const first = t.today - startDow - (weeks - 1) * 7
  const max = Math.max(1, ...[...perDay.values()])
  const cells: { d: number; n: number }[] = []
  for (let d = first; d <= t.today; d++) cells.push({ d, n: perDay.get(d) ?? 0 })
  const lvl = (n: number) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)))

  // forecast: next 30 days
  const horizon = 30
  const forecast = Array.from({ length: horizon }, () => 0)
  for (const c of cards) {
    if (c.suspended) continue
    if (c.queue === 2 || c.queue === 3) {
      const off = Math.max(0, c.due - t.today)
      if (off < horizon) forecast[off]++
    } else if (c.queue === 1) forecast[0]++
  }
  const fmax = Math.max(1, ...forecast)

  const answers = [1, 2, 3, 4].map((r) => revlog.filter((x) => x.rating === r && dayNumber(x.time) > t.today - 30).length)
  const answersTotal = answers.reduce((a, b) => a + b, 0) || 1

  return (
    <main class="page">
      <div class="hero" style={{ alignItems: 'flex-end' }}>
        <div>
          <p class="eyebrow">Statistics</p>
          <h1 class="display" style={{ fontSize: 'clamp(32px, 5vw, 46px)' }}>The <em>long view</em>.</h1>
        </div>
        <select class="select" style={{ width: 'auto', minWidth: '200px' }} value={deck} onChange={(e) => setDeck(e.currentTarget.value)}>
          <option value="">All stacks</option>
          {decks.map((d) => <option value={d.id}>{d.name}</option>)}
        </select>
      </div>

      <div class="tiles">
        <div class="tile paper"><i>Today</i><b>{today}</b><small>{todayMin} min studying</small></div>
        <div class="tile paper"><i>Streak</i><b>{streak(s)}</b><small>days in a row</small></div>
        <div class="tile paper"><i>Retention · 30d</i><b>{retention == null ? '—' : `${retention}%`}</b><small>{recent.length} review answers</small></div>
        <div class="tile paper"><i>Mature</i><b>{mature}</b><small>of {cards.length} cards</small></div>
      </div>

      <h2 class="section">Practice <small>the past year</small></h2>
      <div class="chartcard paper" ref={(el) => { if (el) el.scrollLeft = el.scrollWidth }}>
        <div class="heat">
          {cells.map((c) => (
            <i data-l={lvl(c.n)} class={c.d === t.today ? 'today' : ''} title={`${new Date(dayStartMs(c.d)).toLocaleDateString()}: ${c.n} reviews`} />
          ))}
        </div>
      </div>

      <h2 class="section">Forecast <small>cards due, next 30 days</small></h2>
      <div class="chartcard paper">
        <div class="bars">
          {forecast.map((n, i) => (
            <div title={`${i === 0 ? 'Today' : `In ${i}d`}: ${n}`}>
              {n > 0 && i < 14 && <em>{n}</em>}
              <span style={{ height: `${(n / fmax) * 100}%` }} />
            </div>
          ))}
        </div>
        <div class="axis"><span>today</span><span>+1 week</span><span>+2 weeks</span><span>+3 weeks</span><span>+30d</span></div>
      </div>

      <h2 class="section">Answer buttons <small>last 30 days</small></h2>
      <div class="chartcard paper">
        <div class="statebar" style={{ height: '14px' }}>
          {['var(--again)', 'var(--hard)', 'var(--good)', 'var(--easy)'].map((c, i) => answers[i] > 0 && <span style={{ width: `${(answers[i] / answersTotal) * 100}%`, background: c }} />)}
        </div>
        <div class="legend" style={{ marginTop: '12px' }}>
          {['Again', 'Hard', 'Good', 'Easy'].map((l, i) => (
            <span style={{ '--c': ['var(--again)', 'var(--hard)', 'var(--good)', 'var(--easy)'][i] } as any}>
              {l} {answers[i]} ({Math.round((answers[i] / answersTotal) * 100)}%)
            </span>
          ))}
        </div>
      </div>
    </main>
  )
}
