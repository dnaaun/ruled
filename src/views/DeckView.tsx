import { useState } from 'preact/hooks'
import { go, Icon, Modal, plural, toast, useStore, useTick } from '../components/ui'
import type { NoteKind } from '../lib/model'
import { buildQueue, deleteDeck, importRows, nextLearningDue, parseDelimited, updateDeck, PALETTE } from '../lib/ops'
import { openTextFile } from '../lib/platform'
import { timing } from '../lib/scheduler/timing'

export function DeckView({ id }: { id: string }) {
  const s = useStore()
  useTick(20_000)
  const deck = s.get('decks', id)
  const [editing, setEditing] = useState(false)
  const [importing, setImporting] = useState(false)
  if (!deck) {
    return (
      <main class="page"><div class="empty"><h3>That stack is gone.</h3><a class="btn" href="#/">Back to stacks</a></div></main>
    )
  }
  const t = timing()
  const q = buildQueue(s, id, t)
  const c = q.counts
  const cards = s.all('cards').filter((x) => x.deckId === id)
  const totalDue = c.new + c.learn + c.review
  const st = {
    new: cards.filter((x) => x.type === 0 && !x.suspended).length,
    learning: cards.filter((x) => (x.type === 1 || x.type === 3) && !x.suspended).length,
    young: cards.filter((x) => x.type === 2 && x.ivl < 21 && !x.suspended).length,
    mature: cards.filter((x) => x.type === 2 && x.ivl >= 21 && !x.suspended).length,
    suspended: cards.filter((x) => x.suspended).length,
  }
  const nextLearn = nextLearningDue(s, id)
  const tomorrow = cards.filter((x) => !x.suspended && (x.queue === 2 || x.queue === 3) && x.due === t.today + 1).length

  const rename = (v: string) => {
    if (v.trim() && v.trim() !== deck.name) updateDeck(s, id, { name: v.trim() })
    setEditing(false)
  }

  const bar = [
    ['var(--new)', st.new, 'new'],
    ['var(--learn)', st.learning, 'learning'],
    ['color-mix(in srgb, var(--review) 55%, transparent)', st.young, 'young'],
    ['var(--review)', st.mature, 'mature'],
    ['var(--ink-3)', st.suspended, 'suspended'],
  ] as const
  const total = cards.length || 1

  return (
    <main class="page">
      <a class="back-link" href="#/"><Icon.back width={14} height={14} /> All stacks</a>
      <div class="deckhead">
        <div>
          <p class="eyebrow">Stack · {plural(cards.length, 'card')}</p>
          <h1 class="display" onClick={() => setEditing(true)} title="Click to rename">
            {editing ? (
              <input
                autoFocus
                defaultValue={deck.name}
                onBlur={(e) => rename(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') rename(e.currentTarget.value)
                  if (e.key === 'Escape') setEditing(false)
                }}
              />
            ) : (
              deck.name
            )}
          </h1>
        </div>
        <div class="bigcounts">
          <span class={c.new ? 'c-new' : 'zero'}><b>{c.new}</b><i>New</i></span>
          <span class={c.learn ? 'c-learn' : 'zero'}><b>{c.learn}</b><i>Learning</i></span>
          <span class={c.review ? 'c-review' : 'zero'}><b>{c.review}</b><i>To review</i></span>
        </div>
      </div>

      <div class="deckpanel">
        <div class="studycard paper ruled">
          <p class="when">
            {totalDue
              ? `${plural(totalDue, 'card')} ready. Roughly ${Math.max(1, Math.round((c.new * 25 + c.learn * 10 + c.review * 8) / 60))} min.`
              : cards.length === 0
                ? 'An empty stack. Write the first card.'
                : nextLearn && nextLearn - t.now < 3600 * 6
                  ? `All caught up — a learning card returns in ${Math.max(1, Math.round((nextLearn - t.now) / 60))} min.`
                  : `All caught up. ${tomorrow ? `${plural(tomorrow, 'card')} tomorrow.` : 'Nothing due tomorrow.'}`}
          </p>
          <div class="actions row">
            {totalDue > 0 && (
              <button class="btn primary big" onClick={() => go(`study/${id}`)}><Icon.play /> Study now</button>
            )}
            <button class={`btn ${totalDue ? '' : 'primary'} big`} onClick={() => go(`add/${id}`)}><Icon.plus /> Add cards</button>
          </div>
        </div>

        <div class="facts paper">
          <div class="fact"><b>{st.mature}</b><i>Mature (≥21d)</i></div>
          <div class="fact"><b>{st.young}</b><i>Young</i></div>
          <div class="fact"><b>{st.new}</b><i>Unseen</i></div>
          <div class="fact"><b>{st.suspended}</b><i>Suspended</i></div>
          <div class="statebar">
            {bar.map(([col, n]) => n > 0 && <span style={{ width: `${(n / total) * 100}%`, background: col }} />)}
          </div>
          <div class="legend">
            {bar.map(([col, n, l]) => <span style={{ '--c': col } as any}>{l} {n}</span>)}
          </div>
        </div>
      </div>

      <div class="toolrow">
        <a class="btn ghost" href={`#/browse?deck=${id}`}><Icon.search /> Browse</a>
        <a class="btn ghost" href={`#/options/${id}`}><Icon.gear /> Options</a>
        <button class="btn ghost" onClick={() => setImporting(true)}><Icon.upload /> Import text</button>
        <a class="btn ghost" href={`#/stats?deck=${id}`}><Icon.chart /> Stats</a>
        <span class="grow" />
        <div class="row" style={{ gap: '6px' }} aria-label="Tab colour">
          {PALETTE.map((p) => (
            <button
              title="Tab colour"
              onClick={() => updateDeck(s, id, { color: p })}
              style={{
                width: '18px', height: '18px', borderRadius: '50%', border: 0, cursor: 'pointer', background: `var(--tab-${p})`,
                boxShadow: deck.color === p ? '0 0 0 2px var(--desk), 0 0 0 3.5px var(--ink)' : 'none',
              }}
            />
          ))}
        </div>
        <button
          class="btn ghost danger"
          onClick={() => {
            if (confirm(`Delete “${deck.name}” and its ${plural(cards.length, 'card')}? This syncs to your other devices.`)) {
              deleteDeck(s, id)
              go('')
              toast('Stack deleted')
            }
          }}
        >
          <Icon.trash /> Delete
        </button>
      </div>
      {importing && <ImportModal deckId={id} onClose={() => setImporting(false)} />}
    </main>
  )
}

function ImportModal({ deckId, onClose }: { deckId: string; onClose: () => void }) {
  const s = useStore()
  const [text, setText] = useState('')
  const [kind, setKind] = useState<NoteKind>('basic')
  const parsed = parseDelimited(text)
  const sepName = { '\t': 'tab', ',': 'comma', ';': 'semicolon', '|': 'pipe' }[parsed.sep] ?? parsed.sep
  return (
    <Modal onClose={onClose}>
      <h3>Import cards from text</h3>
      <p class="muted small" style={{ marginTop: 0 }}>
        One card per line: <span class="mono">front⇥back⇥tags</span>. Tab, comma, semicolon or pipe separated — Anki’s “Notes in Plain Text” export works as-is.
      </p>
      <label class="field">
        <span>Paste text</span>
        <textarea class="textarea mono" style={{ fontSize: '13px', minHeight: '160px' }} value={text} onInput={(e) => setText(e.currentTarget.value)} placeholder={'bonjour\thello\nmerci\tthank you'} />
      </label>
      <div class="row" style={{ marginBottom: '18px' }}>
        <button class="btn" onClick={async () => { const t = await openTextFile(['txt', 'csv', 'tsv']); if (t != null) setText(t) }}><Icon.upload /> Choose file…</button>
        <div class="seg">
          {(['basic', 'reversed', 'cloze'] as NoteKind[]).map((k) => (
            <button class={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{k === 'reversed' ? 'basic + reversed' : k}</button>
          ))}
        </div>
      </div>
      <div class="row end">
        <span class="muted small mono grow">{parsed.rows.length ? `${parsed.rows.length} rows · ${sepName}` : ''}</span>
        <button class="btn ghost" onClick={onClose}>Cancel</button>
        <button
          class="btn primary"
          disabled={!parsed.rows.length}
          onClick={() => {
            const n = importRows(s, deckId, parsed.rows, kind)
            toast(`Imported ${plural(n, 'note')}`)
            onClose()
          }}
        >
          Import
        </button>
      </div>
    </Modal>
  )
}
