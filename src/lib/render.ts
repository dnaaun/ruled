import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { Note } from './model'

marked.setOptions({ gfm: true, breaks: true })

const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([^}]*?))?\}\}/g

export function md(text: string): string {
  return DOMPurify.sanitize(marked.parse(text ?? '', { async: false }) as string)
}

export function clozeOrds(text: string): number[] {
  const set = new Set<number>()
  for (const m of text.matchAll(CLOZE_RE)) set.add(parseInt(m[1], 10))
  return [...set].filter((n) => n > 0).sort((a, b) => a - b)
}

export function nextClozeNumber(text: string): number {
  const ords = clozeOrds(text)
  return ords.length ? ords[ords.length - 1] + 1 : 1
}

function escapeAttr(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

export function renderCloze(text: string, ord: number, side: 'front' | 'back'): string {
  return text.replace(CLOZE_RE, (_m, n: string, content: string, hint?: string) => {
    if (parseInt(n, 10) !== ord) return content
    if (side === 'front') return `<span class="cloze">${hint ? escapeAttr(hint) : '&nbsp;…&nbsp;'}</span>`
    return `<span class="cloze revealed">${content}</span>`
  })
}

/** Which card ordinals a note should have. */
export function noteOrds(note: Pick<Note, 'kind' | 'fields'>): number[] {
  if (note.kind === 'basic') return [0]
  if (note.kind === 'reversed') return [0, 1]
  const ords = clozeOrds(note.fields.text ?? '')
  return ords.length ? ords : [1]
}

export interface Sides { front: string; back: string; replaceFront: boolean }

export function cardSides(note: Note, ord: number): Sides {
  const f = note.fields
  if (note.kind === 'cloze') {
    const extra = f.extra?.trim() ? `<div class="extra">${md(f.extra)}</div>` : ''
    return {
      front: md(renderCloze(f.text ?? '', ord, 'front')),
      back: md(renderCloze(f.text ?? '', ord, 'back')) + extra,
      replaceFront: true,
    }
  }
  const a = md(f.front ?? '')
  const b = md(f.back ?? '')
  return ord === 1 ? { front: b, back: a, replaceFront: false } : { front: a, back: b, replaceFront: false }
}

/** Plain-text preview of a note (for lists). */
export function plain(text: string): string {
  return (text ?? '')
    .replace(CLOZE_RE, (_m, _n, c: string) => `[${c}]`)
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function notePrimary(note: Note): string {
  return plain(note.kind === 'cloze' ? note.fields.text : note.fields.front)
}
export function noteSecondary(note: Note): string {
  return plain(note.kind === 'cloze' ? note.fields.extra ?? '' : note.fields.back)
}
