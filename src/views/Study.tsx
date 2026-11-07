import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { go, Icon, toast, useStore, useTick } from '../components/ui'
import { answer, buildQueue, buryCard, deckConfig, deleteNote, liveCounts, nextCard, nextLearningDue, setSuspended, undoAnswer, type UndoEntry } from '../lib/ops'
import { cardSides } from '../lib/render'
import { buttonInterval, formatInterval, previewStates, type Rating, stateFor } from '../lib/scheduler/answer'
import { timing } from '../lib/scheduler/timing'

const LABELS: [Rating, string, string][] = [
  [1, 'Again', 'var(--again)'],
  [2, 'Hard', 'var(--hard)'],
  [3, 'Good', 'var(--good)'],
  [4, 'Easy', 'var(--easy)'],
]

export function Study({ id }: { id: string }) {
  const s = useStore()
  useTick(15_000)
  const deck = s.get('decks', id)
  const [main] = useState(() => buildQueue(s, id).main)
  const [curId, setCurId] = useState<string | null>(() => nextCard(s, id, main)?.id ?? null)
  const [revealed, setRevealed] = useState(false)
  const [menu, setMenu] = useState(false)
  const [undo, setUndo] = useState<UndoEntry[]>([])
  const [answered, setAnswered] = useState(0)
  const shownAt = useRef(Date.now())
  const [dealKey, setDealKey] = useState(0)

  const t = timing()
  const card = curId ? s.get('cards', curId) : undefined
  const note = card ? s.get('notes', card.noteId) : undefined

  // if the current card vanished (deleted / synced away), or nothing showing but a learning card came due
  useEffect(() => {
    if (!card || !note || card.suspended) {
      const n = nextCard(s, id, main)
      if ((n?.id ?? null) !== curId) {
        setCurId(n?.id ?? null)
        setRevealed(false)
        shownAt.current = Date.now()
      }
    }
  })

  const cfg = deckConfig(s, id)
  const states = useMemo(() => (card ? previewStates(card, cfg, t) : null), [card?.id, card?.hlc])
  const sides = card && note ? cardSides(note, card.ord) : null
  const counts = liveCounts(s, id, main, t)

  const advance = () => {
    const n = nextCard(s, id, main)
    setCurId(n?.id ?? null)
    setRevealed(false)
    setDealKey((k) => k + 1)
    shownAt.current = Date.now()
  }

  const rate = (r: Rating) => {
    if (!card || !revealed) return
    const u = answer(s, card.id, r, Date.now() - shownAt.current)
    if (u) setUndo((x) => [...x.slice(-30), u])
    setAnswered((n) => n + 1)
    advance()
  }

  const doUndo = () => {
    const u = undo[undo.length - 1]
    if (!u) return toast('Nothing to undo')
    undoAnswer(s, u)
    setUndo((x) => x.slice(0, -1))
    setAnswered((n) => Math.max(0, n - 1))
    setCurId(u.card.id)
    setRevealed(false)
    setDealKey((k) => k + 1)
    shownAt.current = Date.now()
    toast('Undid last answer')
  }

  const doBury = () => {
    if (!card) return
    buryCard(s, card.id)
    toast('Buried until tomorrow')
    advance()
  }
  const doSuspend = () => {
    if (!card) return
    const cid = card.id
    setSuspended(s, cid, true)
    toast('Card suspended', { label: 'Undo', fn: () => setSuspended(s, cid, false) })
    advance()
  }
  const doDelete = () => {
    if (!note || !confirm('Delete this note and all its cards?')) return
    deleteNote(s, note.id)
    toast('Note deleted')
    advance()
  }
  const doEdit = () => note && go(`edit/${note.id}?back=${encodeURIComponent(`study/${id}`)}`)

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea')) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') return e.preventDefault(), doUndo()
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        if (!revealed) setRevealed(true)
        else rate(3)
      } else if (revealed && ['1', '2', '3', '4'].includes(e.key)) rate(Number(e.key) as Rating)
      else if (e.key === 'z' || e.key === 'u') doUndo()
      else if (e.key === 'e') doEdit()
      else if (e.key === '-') doBury()
      else if (e.key === '@' || e.key === '!') doSuspend()
      else if (e.key === 'Escape') menu ? setMenu(false) : go(`deck/${id}`)
    }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  })

  const which = card ? (card.queue === 0 ? 'new' : card.queue === 2 ? 'review' : 'learn') : ''
  const nextLearn = nextLearningDue(s, id)

  return (
    <div class="studyshell">
      <div class="studytop" data-tauri-drag-region>
        <a class="iconbtn" href={`#/deck/${id}`} title="Back (Esc)"><Icon.close /></a>
        <span class="title">{deck?.name}</span>
        <div class="live">
          <span class={`c-new ${which === 'new' ? 'cur' : ''} ${counts.new ? '' : 'zero'}`}>{counts.new}</span>
          <span class={`c-learn ${which === 'learn' ? 'cur' : ''} ${counts.learn ? '' : 'zero'}`}>{counts.learn}</span>
          <span class={`c-review ${which === 'review' ? 'cur' : ''} ${counts.review ? '' : 'zero'}`}>{counts.review}</span>
        </div>
        <div class="menu">
          <button class="iconbtn" onClick={() => setMenu(!menu)} aria-label="More"><Icon.more /></button>
          {menu && (
            <div class="pop" onClick={() => setMenu(false)}>
              <button onClick={doUndo} disabled={!undo.length}>Undo answer <kbd>Z</kbd></button>
              <hr />
              <button onClick={doEdit} disabled={!card}>Edit note <kbd>E</kbd></button>
              <button onClick={doBury} disabled={!card}>Bury until tomorrow <kbd>-</kbd></button>
              <button onClick={doSuspend} disabled={!card}>Suspend card <kbd>@</kbd></button>
              <hr />
              <button onClick={doDelete} disabled={!card} style={{ color: 'var(--learn)' }}>Delete note</button>
            </div>
          )}
        </div>
      </div>

      {card && sides && states ? (
        <>
          <div class="stage">
            <article class="notecard paper ruled" key={`${card.id}-${dealKey}`}>
              <span class="chip">{note?.kind === 'cloze' ? `cloze ${card.ord}` : note?.kind === 'reversed' ? (card.ord ? 'reverse' : 'forward') : 'basic'}</span>
              {note && note.tags.length > 0 && <span class="chip r">{note.tags.slice(0, 3).map((x) => `#${x}`).join(' ')}</span>}
              {!(revealed && sides.replaceFront) && <div class="front content" dangerouslySetInnerHTML={{ __html: sides.front }} />}
              {revealed && !sides.replaceFront && <div class="divider" />}
              {revealed && <div class="back content" dangerouslySetInnerHTML={{ __html: sides.back }} />}
            </article>
          </div>
          <div class="answerbar">
            {!revealed ? (
              <div style={{ width: '100%', maxWidth: '720px' }}>
                <button class="btn primary reveal" onClick={() => setRevealed(true)}>Show answer</button>
                <div class="kbdhint">space to flip · 1–4 to answer · z undo · e edit</div>
              </div>
            ) : (
              <div style={{ width: '100%', maxWidth: '720px' }}>
                <div class="answers">
                  {LABELS.map(([r, label, c]) => {
                    const st = stateFor(states, r)
                    const learning = st.kind === 'learn' || st.kind === 'relearn'
                    return (
                      <button class="ans" style={{ '--c': c } as any} onClick={() => rate(r)}>
                        <kbd>{r}</kbd>
                        <span class="ivl">{formatInterval(buttonInterval(st, t), learning)}</span>
                        <span class="lbl">{label}</span>
                      </button>
                    )
                  })}
                </div>
                <div class="kbdhint">space = good</div>
              </div>
            )}
          </div>
        </>
      ) : (
        <div class="done">
          <div class="pile">
            <i /><i /><i />
            <span class="stamp">Stack<br />cleared</span>
          </div>
          <h1 class="display" style={{ fontSize: '40px' }}>
            {answered ? <>Nicely done.</> : <>Nothing due <em>right now</em>.</>}
          </h1>
          <p class="lede" style={{ margin: '0 auto 26px' }}>
            {answered ? `${answered} ${answered === 1 ? 'card' : 'cards'} this session. ` : ''}
            {nextLearn
              ? `A learning card comes back in ${Math.max(1, Math.round((nextLearn - t.now) / 60))} min — leave this open and it’ll appear.`
              : 'Come back tomorrow; the scheduler has the rest.'}
          </p>
          <div class="row" style={{ justifyContent: 'center' }}>
            {undo.length > 0 && <button class="btn" onClick={doUndo}>Undo last</button>}
            <a class="btn primary" href={`#/deck/${id}`}>Back to stack</a>
          </div>
        </div>
      )}
    </div>
  )
}
