import { useEffect, useRef, useState } from 'preact/hooks'
import { go, Icon, toast, useStore } from '../components/ui'
import type { Note, NoteKind } from '../lib/model'
import { addNote, cardsOf, deleteNote, forgetCard, setSuspended, updateNote, revlogFor } from '../lib/ops'
import { cardSides, nextClozeNumber, noteOrds, notePrimary } from '../lib/render'
import { timing } from '../lib/scheduler/timing'

const KINDS: [NoteKind, string][] = [
  ['basic', 'Basic'],
  ['reversed', 'Basic + reversed'],
  ['cloze', 'Cloze'],
]

export function Editor({ deckId, noteId, back }: { deckId?: string; noteId?: string; back?: string }) {
  const s = useStore()
  const existing = noteId ? s.get('notes', noteId) : undefined
  const decks = s.all('decks').sort((a, b) => a.name.localeCompare(b.name))
  const [deck, setDeck] = useState(existing?.deckId ?? deckId ?? s.getKv<string>('lastDeck') ?? decks[0]?.id ?? '')
  const [kind, setKind] = useState<NoteKind>(existing?.kind ?? s.getKv<NoteKind>('lastKind') ?? 'basic')
  const [fields, setFields] = useState<Record<string, string>>(existing?.fields ?? {})
  const [tags, setTags] = useState((existing?.tags ?? s.getKv<string[]>('lastTags') ?? []).join(' '))
  const [added, setAdded] = useState<Note[]>([])
  const [previewOrd, setPreviewOrd] = useState(0)
  const [flip, setFlip] = useState(false)
  const firstRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!existing && !s.get('decks', deck) && decks[0]) setDeck(decks[0].id)
  }, [decks.length])

  if (noteId && !existing) {
    return <main class="page narrow"><div class="empty"><h3>This note no longer exists.</h3><a class="btn" href="#/browse">Browse</a></div></main>
  }
  if (!decks.length) {
    return <main class="page narrow"><div class="empty"><h3>Make a stack first.</h3><a class="btn primary" href="#/">Go to stacks</a></div></main>
  }

  const keys = kind === 'cloze' ? (['text', 'extra'] as const) : (['front', 'back'] as const)
  const labels: Record<string, string> = { front: 'Front', back: 'Back', text: 'Text', extra: 'Back extra' }
  const tagList = tags.split(/[\s,]+/).map((x) => x.replace(/^#/, '')).filter(Boolean)
  const primary = (fields[keys[0]] ?? '').trim()
  const valid = primary.length > 0 && (kind !== 'cloze' || /\{\{c\d+::/.test(primary))

  const draft = { kind, fields: { ...fields } } as Note
  const ords = noteOrds(draft)
  const ord = ords.includes(previewOrd) ? previewOrd : ords[0]
  const sides = cardSides(draft, ord)

  const save = () => {
    if (!valid) {
      toast(kind === 'cloze' ? 'Add at least one {{c1::cloze}}' : 'The front can’t be empty')
      return
    }
    const clean: Record<string, string> = {}
    for (const k of keys) clean[k] = (fields[k] ?? '').trim()
    if (existing) {
      updateNote(s, existing.id, { fields: clean, tags: tagList, deckId: deck, kind })
      toast('Saved')
      go(back ?? `browse?deck=${deck}`)
    } else {
      const n = addNote(s, deck, kind, clean, tagList)
      s.setKv('lastDeck', deck)
      s.setKv('lastKind', kind)
      s.setKv('lastTags', tagList)
      setAdded((a) => [n, ...a].slice(0, 8))
      setFields({})
      setFlip(false)
      toast(`Added ${noteOrds(n).length > 1 ? `${noteOrds(n).length} cards` : 'card'}`)
      firstRef.current?.focus()
    }
  }

  const cloze = () => {
    const el = firstRef.current
    if (!el || kind !== 'cloze') return
    const v = el.value
    const [a, b] = [el.selectionStart ?? v.length, el.selectionEnd ?? v.length]
    const n = nextClozeNumber(v)
    const inner = v.slice(a, b) || '…'
    const next = `${v.slice(0, a)}{{c${n}::${inner}}}${v.slice(b)}`
    setFields({ ...fields, text: next })
    requestAnimationFrame(() => {
      el.focus()
      const start = a + `{{c${n}::`.length
      el.setSelectionRange(start, start + inner.length)
    })
  }

  const wrap = (l: string, r = l) => {
    const el = document.activeElement as HTMLTextAreaElement | null
    if (!el || el.tagName !== 'TEXTAREA' || !el.dataset.key) return
    const key = el.dataset.key
    const v = el.value
    const [a, b] = [el.selectionStart, el.selectionEnd]
    setFields({ ...fields, [key]: `${v.slice(0, a)}${l}${v.slice(a, b)}${r}${v.slice(b)}` })
    requestAnimationFrame(() => el.setSelectionRange(a + l.length, b + l.length))
  }

  const onKey = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key === 'Enter') { e.preventDefault(); save() }
    else if (mod && e.shiftKey && e.key.toLowerCase() === 'c') { e.preventDefault(); cloze() }
    else if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); wrap('**') }
    else if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); wrap('*') }
  }

  const cards = existing ? cardsOf(s, existing.id) : []
  const t = timing()

  return (
    <main class="page">
      <a class="back-link" href={`#/${back ?? (existing ? `browse?deck=${deck}` : `deck/${deck}`)}`}><Icon.back width={14} height={14} /> Back</a>
      <p class="eyebrow">{existing ? 'Edit note' : 'New card'}</p>
      <h1 class="display" style={{ fontSize: 'clamp(32px, 5vw, 46px)' }}>{existing ? <>Revise the <em>card</em>.</> : <>Write it <em>down</em>.</>}</h1>

      <div class="editor" style={{ marginTop: '28px' }} onKeyDown={onKey}>
        <div>
          <div class="row" style={{ marginBottom: '18px' }}>
            <div class="seg">
              {KINDS.map(([k, l]) => (
                <button class={kind === k ? 'on' : ''} onClick={() => {
                  if (k === kind) return
                  // carry text across sensibly
                  const f = kind === 'cloze' ? { front: fields.text ?? '', back: fields.extra ?? '' } : k === 'cloze' ? { text: fields.front ?? '', extra: fields.back ?? '' } : fields
                  setFields(f)
                  setKind(k)
                }}>{l}</button>
              ))}
            </div>
          </div>
          <label class="field">
            <span>Stack</span>
            <select class="select" value={deck} onChange={(e) => setDeck(e.currentTarget.value)}>
              {decks.map((d) => <option value={d.id}>{d.name}</option>)}
            </select>
          </label>
          {keys.map((k, i) => (
            <label class="field">
              <span>{labels[k]}</span>
              <textarea
                ref={i === 0 ? firstRef : undefined}
                data-key={k}
                class="textarea"
                autoFocus={i === 0}
                value={fields[k] ?? ''}
                onInput={(e) => {
                  setFields({ ...fields, [k]: e.currentTarget.value })
                  if (k === 'back' || k === 'extra') setFlip(true)
                  else setFlip(false)
                }}
                placeholder={k === 'text' ? 'The mitochondria is the {{c1::powerhouse}} of the cell.' : k === 'front' ? 'Question, word, prompt…' : k === 'back' ? 'Answer' : 'Shown after the answer (optional)'}
              />
            </label>
          ))}
          <div class="tools">
            {kind === 'cloze' && <button class="btn" onClick={cloze} title="Ctrl/⌘ + Shift + C">[…] Cloze deletion</button>}
            <button class="btn ghost" onMouseDown={(e) => { e.preventDefault(); wrap('**') }} title="Ctrl/⌘ + B"><b>B</b></button>
            <button class="btn ghost" onMouseDown={(e) => { e.preventDefault(); wrap('*') }} title="Ctrl/⌘ + I"><i>I</i></button>
            <button class="btn ghost" onMouseDown={(e) => { e.preventDefault(); wrap('`') }} title="Code"><span class="mono">{'</>'}</span></button>
            <span class="hint" style={{ alignSelf: 'center', margin: 0 }}>Markdown works.</span>
          </div>
          <label class="field">
            <span>Tags</span>
            <input class="input mono tags-input" value={tags} onInput={(e) => setTags(e.currentTarget.value)} placeholder="space separated" />
          </label>
          <div class="row">
            <button class="btn primary big" onClick={save} disabled={!valid}>{existing ? 'Save changes' : kind === 'cloze' || kind === 'reversed' ? `Add ${ords.length} card${ords.length > 1 ? 's' : ''}` : 'Add card'}</button>
            <span class="hint mono" style={{ margin: 0 }}>⌘/Ctrl + Enter</span>
            <span class="grow" />
            {existing && (
              <button class="btn ghost danger" onClick={() => {
                if (!confirm('Delete this note and its cards?')) return
                deleteNote(s, existing.id)
                toast('Note deleted')
                go(back ?? `browse?deck=${deck}`)
              }}><Icon.trash /> Delete</button>
            )}
          </div>

          {existing && cards.length > 0 && (
            <div class="added">
              <p class="eyebrow">Cards</p>
              <ul>
                {cards.sort((a, b) => a.ord - b.ord).map((c) => {
                  const revs = revlogFor(s, c.id)
                  const state = c.suspended ? 'suspended' : c.type === 0 ? 'new' : c.type === 2 ? `review · ${c.ivl}d · ease ${(c.factor / 10).toFixed(0)}%` : 'learning'
                  const due = c.type === 0 ? '' : c.queue === 1 ? 'due soon' : `due ${c.due - t.today <= 0 ? 'today' : `in ${c.due - t.today}d`}`
                  return (
                    <li class="row" style={{ justifyContent: 'space-between' }}>
                      <span class="mono small">{kind === 'cloze' ? `c${c.ord}` : c.ord ? 'reverse' : 'forward'} — {state} {due && `· ${due}`} · {revs.length} reviews · {c.lapses} lapses</span>
                      <span class="row" style={{ gap: '4px' }}>
                        <button class="btn ghost" style={{ padding: '5px 10px', fontSize: '11px' }} onClick={() => setSuspended(s, c.id, !c.suspended)}>{c.suspended ? 'Unsuspend' : 'Suspend'}</button>
                        <button class="btn ghost" style={{ padding: '5px 10px', fontSize: '11px' }} onClick={() => { if (confirm('Reset this card to new? Its review history is kept.')) forgetCard(s, c.id) }}>Forget</button>
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {added.length > 0 && (
            <div class="added">
              <p class="eyebrow">Just added</p>
              <ul>
                {added.map((n) => <li><a href={`#/edit/${n.id}?back=${encodeURIComponent(`add/${deck}`)}`} style={{ textDecoration: 'none' }}>{notePrimary(n)}</a></li>)}
              </ul>
            </div>
          )}
        </div>

        <div class="preview">
          <div class="row" style={{ marginBottom: '12px', justifyContent: 'space-between' }}>
            <p class="eyebrow" style={{ margin: 0 }}>Preview</p>
            <div class="seg">
              <button class={!flip ? 'on' : ''} onClick={() => setFlip(false)}>Front</button>
              <button class={flip ? 'on' : ''} onClick={() => setFlip(true)}>Back</button>
            </div>
          </div>
          <article class="notecard paper ruled">
            <span class="chip">{kind === 'cloze' ? `cloze ${ord}` : ord ? 'reverse' : 'forward'}</span>
            {!(flip && sides.replaceFront) && <div class="front content" dangerouslySetInnerHTML={{ __html: sides.front || '<p class="muted">…</p>' }} />}
            {flip && !sides.replaceFront && <div class="divider" />}
            {flip && <div class="back content" dangerouslySetInnerHTML={{ __html: sides.back }} />}
          </article>
          {ords.length > 1 && (
            <div class="row" style={{ marginTop: '12px', justifyContent: 'center' }}>
              <div class="seg">
                {ords.map((o) => <button class={o === ord ? 'on' : ''} onClick={() => setPreviewOrd(o)}>{kind === 'cloze' ? `c${o}` : o ? 'reverse' : 'forward'}</button>)}
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
