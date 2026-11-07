import { useState } from 'preact/hooks'
import { Icon, toast, useStore } from '../components/ui'
import { DEFAULT_CONFIG, type DeckConfig } from '../lib/model'
import { deckConfig, updateDeck } from '../lib/ops'

/** Anki-style step strings: "1m 10m", "30s", "1h", "2d". Stored in minutes. */
export function parseSteps(text: string): number[] | null {
  const parts = text.trim().split(/[\s,]+/).filter(Boolean)
  const out: number[] = []
  for (const p of parts) {
    const m = p.match(/^(\d+(?:\.\d+)?)([smhd]?)$/i)
    if (!m) return null
    const v = parseFloat(m[1])
    const mult = { s: 1 / 60, m: 1, h: 60, d: 1440, '': 1 }[m[2].toLowerCase() as 's' | 'm' | 'h' | 'd' | '']
    if (!(v > 0)) return null
    out.push(v * mult)
  }
  return out
}

export function formatSteps(steps: number[]): string {
  return steps
    .map((m) => (m < 1 ? `${Math.round(m * 60)}s` : m >= 1440 && m % 1440 === 0 ? `${m / 1440}d` : m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${+m.toFixed(2)}m`))
    .join(' ')
}

type NumKey = { [K in keyof DeckConfig]: DeckConfig[K] extends number ? K : never }[keyof DeckConfig]

export function Options({ id }: { id: string }) {
  const s = useStore()
  const deck = s.get('decks', id)
  const [cfg, setCfg] = useState<DeckConfig>(() => deckConfig(s, id))
  const [learn, setLearn] = useState(formatSteps(cfg.learnSteps))
  const [relearn, setRelearn] = useState(formatSteps(cfg.relearnSteps))
  if (!deck) return <main class="page narrow"><div class="empty"><h3>No such stack.</h3></div></main>

  const learnOk = parseSteps(learn) != null
  const relearnOk = parseSteps(relearn) != null

  const num = (key: NumKey, label: string, hint: string, opts: { pct?: boolean; step?: number; min?: number } = {}) => (
    <label class="field">
      <span>{label}</span>
      <input
        class="input mono"
        type="number"
        inputMode="decimal"
        step={opts.step ?? 1}
        min={opts.min ?? 0}
        value={opts.pct ? Math.round(cfg[key] * 100) : cfg[key]}
        onInput={(e) => {
          const v = parseFloat(e.currentTarget.value)
          if (Number.isFinite(v)) setCfg({ ...cfg, [key]: opts.pct ? v / 100 : v })
        }}
      />
      <div class="hint">{hint}</div>
    </label>
  )

  const save = () => {
    const ls = parseSteps(learn)
    const rs = parseSteps(relearn)
    if (!ls || !rs) return toast('Fix the steps first — e.g. “1m 10m”')
    const next: DeckConfig = {
      ...cfg,
      learnSteps: ls,
      relearnSteps: rs,
      newPerDay: Math.max(0, Math.round(cfg.newPerDay)),
      reviewsPerDay: Math.max(0, Math.round(cfg.reviewsPerDay)),
      graduatingIvl: Math.max(1, Math.round(cfg.graduatingIvl)),
      easyIvl: Math.max(1, Math.round(cfg.easyIvl)),
      minLapseIvl: Math.max(1, Math.round(cfg.minLapseIvl)),
      maxIvl: Math.max(1, Math.round(cfg.maxIvl)),
      initialEase: Math.max(1.31, cfg.initialEase),
      leechThreshold: Math.max(0, Math.round(cfg.leechThreshold)),
    }
    updateDeck(s, id, { config: next })
    toast('Options saved')
    history.back()
  }

  return (
    <main class="page narrow">
      <a class="back-link" href={`#/deck/${id}`}><Icon.back width={14} height={14} /> {deck.name}</a>
      <p class="eyebrow">Options</p>
      <h1 class="display" style={{ fontSize: 'clamp(32px, 5vw, 46px)' }}>Tune the <em>scheduler</em>.</h1>
      <p class="lede" style={{ marginBottom: '30px' }}>
        These are Anki’s deck options, with Anki’s defaults. The algorithm behind them is Anki’s v3 scheduler, ported line for line.
      </p>

      <section class="optgroup paper">
        <h3>Daily limits</h3>
        <div class="opts">
          {num('newPerDay', 'New cards / day', 'Default 20.')}
          {num('reviewsPerDay', 'Maximum reviews / day', 'Default 200. Also caps new cards, as in Anki.')}
        </div>
      </section>

      <section class="optgroup paper">
        <h3>New cards</h3>
        <div class="opts">
          <label class="field">
            <span>Learning steps</span>
            <input class="input mono" value={learn} onInput={(e) => setLearn(e.currentTarget.value)} style={learnOk ? {} : { boxShadow: 'inset 0 0 0 2px var(--learn)' }} />
            <div class="hint">Default “1m 10m”. Use s, m, h, d.</div>
          </label>
          <label class="field">
            <span>Insertion order</span>
            <select class="select" value={cfg.newMix} onChange={(e) => setCfg({ ...cfg, newMix: e.currentTarget.value as DeckConfig['newMix'] })}>
              <option value="mix">Mix with reviews</option>
              <option value="after">Show after reviews</option>
              <option value="before">Show before reviews</option>
            </select>
            <div class="hint">Anki’s “new/review order”.</div>
          </label>
          {num('graduatingIvl', 'Graduating interval (days)', 'Default 1. After the last learning step.')}
          {num('easyIvl', 'Easy interval (days)', 'Default 4. When you press Easy on a new card.')}
        </div>
      </section>

      <section class="optgroup paper">
        <h3>Lapses</h3>
        <div class="opts">
          <label class="field">
            <span>Relearning steps</span>
            <input class="input mono" value={relearn} onInput={(e) => setRelearn(e.currentTarget.value)} style={relearnOk ? {} : { boxShadow: 'inset 0 0 0 2px var(--learn)' }} />
            <div class="hint">Default “10m”. Leave empty to skip relearning.</div>
          </label>
          {num('minLapseIvl', 'Minimum interval (days)', 'Default 1.')}
          {num('leechThreshold', 'Leech threshold', 'Default 8 lapses. 0 disables.')}
          <label class="field">
            <span>Leech action</span>
            <select class="select" value={cfg.leechAction} onChange={(e) => setCfg({ ...cfg, leechAction: e.currentTarget.value as DeckConfig['leechAction'] })}>
              <option value="tag">Tag only</option>
              <option value="suspend">Suspend card</option>
            </select>
            <div class="hint">Leeches are tagged #leech either way.</div>
          </label>
          {num('lapseMult', 'New interval', 'Default 0%. Share of the old interval kept after a lapse.', { pct: true })}
        </div>
      </section>

      <section class="optgroup paper">
        <h3>Advanced</h3>
        <div class="opts">
          {num('maxIvl', 'Maximum interval (days)', 'Default 36500.')}
          {num('initialEase', 'Starting ease', 'Default 250%.', { pct: true, min: 131 })}
          {num('easyBonus', 'Easy bonus', 'Default 130%.', { pct: true })}
          {num('ivlModifier', 'Interval modifier', 'Default 100%. Scales every review interval.', { pct: true })}
          {num('hardFactor', 'Hard interval', 'Default 120%.', { pct: true })}
        </div>
      </section>

      <div class="row" style={{ position: 'sticky', bottom: '90px', justifyContent: 'flex-end' }}>
        <button class="btn ghost" onClick={() => {
          setCfg({ ...DEFAULT_CONFIG })
          setLearn(formatSteps(DEFAULT_CONFIG.learnSteps))
          setRelearn(formatSteps(DEFAULT_CONFIG.relearnSteps))
        }}>Restore Anki defaults</button>
        <button class="btn primary big" onClick={save} disabled={!learnOk || !relearnOk}>Save options</button>
      </div>
    </main>
  )
}
