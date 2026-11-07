import { useState } from 'preact/hooks'
import { go, Icon, Modal, plural, useStore } from '../components/ui'
import type { ImportProgress, ImportSummary } from '../lib/anki'
import { openBinaryFile } from '../lib/platform'

type State =
  | { step: 'pick' }
  | { step: 'working'; file: string; label: string; frac: number | null }
  | { step: 'done'; file: string; sum: ImportSummary }
  | { step: 'error'; file: string; msg: string }

const PHASE: Record<string, string> = {
  read: 'Loading the reader…',
  open: 'Opening the collection…',
  convert: 'Converting notes…',
  write: 'Writing cards and history…',
}

/** Import an Anki .apkg / .colpkg, keeping scheduling and review history. */
export function AnkiImportModal({ onClose }: { onClose: () => void }) {
  const s = useStore()
  const [st, set] = useState<State>({ step: 'pick' })

  const run = async () => {
    const picked = await openBinaryFile(['apkg', 'colpkg'])
    if (!picked) return
    const file = picked.name
    set({ step: 'working', file, label: 'Reading the file…', frac: null })
    try {
      // lazy: zip, zstd and SQLite (wasm) only load when someone actually imports
      const { importAnkiPackage } = await import('../lib/anki')
      const sum = await importAnkiPackage(s, picked.data, {
        onPhase: (p) => set({ step: 'working', file, label: PHASE[p], frac: null }),
        onProgress: (p: ImportProgress) => set({ step: 'working', file, label: PHASE[p.phase], frac: p.total ? p.done / p.total : null }),
      })
      await s.flush()
      set({ step: 'done', file, sum })
    } catch (e) {
      console.error(e)
      set({ step: 'error', file, msg: (e as Error)?.message || String(e) })
    }
  }

  const busy = st.step === 'working'
  return (
    <Modal onClose={() => !busy && onClose()}>
      <div class="anki-import">
        <p class="eyebrow">Import · Anki package</p>
        <h3>{st.step === 'done' ? 'Moved in.' : st.step === 'error' ? 'That didn’t work.' : 'Bring your Anki collection'}</h3>

        {st.step === 'pick' && (
          <>
            <p class="muted" style={{ marginTop: 0 }}>
              Choose a <span class="mono">.apkg</span> deck or a <span class="mono">.colpkg</span> collection backup. Ruled keeps every card where you left it: due dates, intervals, ease, learning steps, suspended cards, review history and deck options.
            </p>
            <ul class="anki-notes small">
              <li>In Anki: <b>File → Export…</b>, choose <i>Anki Deck Package</i> or <i>Anki Collection Package</i>, and tick <i>Include scheduling information</i>.</li>
              <li>Importing the same file again merges — nothing is duplicated.</li>
              <li>Small images come along; sounds and large images don’t (yet).</li>
            </ul>
            <div class="row end">
              <button class="btn ghost" onClick={onClose}>Cancel</button>
              <button class="btn primary" onClick={run}><Icon.upload /> Choose file…</button>
            </div>
          </>
        )}

        {st.step === 'working' && (
          <div class="anki-progress" aria-live="polite">
            <p class="mono small"><span class="file">{st.file}</span></p>
            <div class={`bar${st.frac == null ? ' indeterminate' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={st.frac == null ? undefined : Math.round(st.frac * 100)}>
              <span style={st.frac == null ? undefined : { width: `${Math.max(3, st.frac * 100)}%` }} />
            </div>
            <p class="muted small">{st.label}</p>
          </div>
        )}

        {st.step === 'done' && <Summary sum={st.sum} file={st.file} onClose={onClose} />}

        {st.step === 'error' && (
          <>
            <p class="mono small"><span class="file">{st.file}</span></p>
            <p class="anki-error">{st.msg}</p>
            <p class="muted small">Make sure it’s a package exported from Anki (2.1 or later works best). Nothing was changed.</p>
            <div class="row end">
              <button class="btn ghost" onClick={onClose}>Close</button>
              <button class="btn primary" onClick={() => set({ step: 'pick' })}>Try another file</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

function Summary({ sum, file, onClose }: { sum: ImportSummary; file: string; onClose: () => void }) {
  const cards = sum.cardsAdded + sum.cardsUpdated
  const notes = sum.notesAdded + sum.notesUpdated
  const nothing = !notes && !cards && !sum.reviewsAdded
  const only = sum.decks.length === 1 ? sum.decks[0] : null
  return (
    <>
      <p class="mono small" style={{ marginTop: 0 }}><span class="file">{file}</span></p>
      <div class="facts anki-facts">
        <div class="fact"><b>{sum.decks.filter((d) => d.created).length}</b><i>New stacks</i></div>
        <div class="fact"><b>{sum.notesAdded}</b><i>Notes added</i></div>
        <div class="fact"><b>{sum.cardsAdded}</b><i>Cards added</i></div>
        <div class="fact"><b>{sum.reviewsAdded}</b><i>Reviews</i></div>
      </div>
      {nothing ? (
        <p class="muted">Everything in this file was already here — nothing new to add.</p>
      ) : (sum.notesUpdated || sum.cardsUpdated) ? (
        <p class="muted small">Updated {plural(sum.notesUpdated, 'note')} and {plural(sum.cardsUpdated, 'card')} that were already here.</p>
      ) : null}
      {sum.decks.length > 0 && (
        <ul class="anki-decks">
          {sum.decks.map((d) => (
            <li key={d.id}>
              <a href={`#/deck/${d.id}`} onClick={onClose}>{d.name}</a>
              <span class="mono small muted">{plural(d.cards, 'card')}{d.created ? '' : ' · merged'}</span>
            </li>
          ))}
        </ul>
      )}
      {sum.skipped.length > 0 && (
        <details class="anki-skipped">
          <summary class="small">Left behind ({sum.skipped.length})</summary>
          <ul class="small muted">{sum.skipped.map((x) => <li>{x}</li>)}</ul>
        </details>
      )}
      <div class="row end">
        {only ? (
          <button class="btn primary" onClick={() => { onClose(); go(`deck/${only.id}`) }}>Open {only.name}</button>
        ) : (
          <button class="btn primary" onClick={onClose}>Done</button>
        )}
      </div>
    </>
  )
}
