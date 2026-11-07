import type { ComponentChildren, JSX } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { store } from '../lib/store'

export function useStore() {
  const [, set] = useState(0)
  useEffect(() => {
    const off = store.subscribe(() => set((v) => v + 1))
    return () => void off()
  }, [])
  return store
}

/** Re-render periodically (learning cards come due, "x minutes ago" labels). */
export function useTick(ms: number) {
  const [, set] = useState(0)
  useEffect(() => {
    const id = setInterval(() => set((v) => v + 1), ms)
    return () => clearInterval(id)
  }, [ms])
}

// ---------------------------------------------------------------- routing

export function parseHash(): { path: string[]; query: URLSearchParams } {
  const raw = location.hash.replace(/^#\/?/, '')
  const [p, q] = raw.split('?')
  return { path: p.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q ?? '') }
}

export function useRoute() {
  const [r, set] = useState(parseHash)
  useEffect(() => {
    const on = () => {
      set(parseHash())
      window.scrollTo(0, 0)
    }
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return r
}

export const go = (path: string) => {
  location.hash = path.startsWith('#') ? path : `#/${path.replace(/^\//, '')}`
}

// ---------------------------------------------------------------- toasts

type Toast = { msg: string; action?: { label: string; fn: () => void } }
let toastSet: ((t: Toast | null) => void) | null = null
let toastTimer: ReturnType<typeof setTimeout> | null = null

export function toast(msg: string, action?: Toast['action'], ms = 3200) {
  toastSet?.({ msg, action })
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastSet?.(null), ms)
}

export function Toaster() {
  const [t, set] = useState<Toast | null>(null)
  useEffect(() => {
    toastSet = set
    return () => void (toastSet = null)
  }, [])
  if (!t) return null
  return (
    <div class="toast" role="status">
      <span>{t.msg}</span>
      {t.action && (
        <button
          onClick={() => {
            t.action!.fn()
            set(null)
          }}
        >
          {t.action.label}
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- modal

export function Modal(props: { onClose: () => void; children: ComponentChildren }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [])
  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="modal paper" role="dialog">{props.children}</div>
    </div>
  )
}

// ---------------------------------------------------------------- icons

const P = (d: string | JSX.Element) => (props: JSX.SVGAttributes<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" {...props}>
    {typeof d === 'string' ? <path d={d} /> : d}
  </svg>
)

export const Icon = {
  stacks: P(<><rect x="4" y="7" width="14" height="11" rx="1.5" /><path d="M7 4.5h12.5a1 1 0 0 1 1 1V15" /></>),
  search: P(<><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>),
  chart: P('M4 20V10M10 20V4M16 20v-7M22 20H2'),
  sync: P(<><path d="M20 11a8 8 0 0 0-14.3-4.3L4 9" /><path d="M4 4v5h5" /><path d="M4 13a8 8 0 0 0 14.3 4.3L20 15" /><path d="M20 20v-5h-5" /></>),
  plus: P('M12 5v14M5 12h14'),
  back: P('M15 18l-6-6 6-6'),
  close: P('M6 6l12 12M18 6 6 18'),
  more: P(<><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></>),
  sun: P(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>),
  moon: P('M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z'),
  laptop: P(<><rect x="4" y="5" width="16" height="11" rx="1.5" /><path d="M2 19h20" /></>),
  phone: P(<><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M11 18.5h2" /></>),
  edit: P('M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z'),
  gear: P(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>),
  upload: P('M12 16V4M7 9l5-5 5 5M4 20h16'),
  download: P('M12 4v12M7 11l5 5 5-5M4 20h16'),
  trash: P('M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'),
  copy: P(<><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></>),
  play: P('M7 4.5v15l12-7.5-12-7.5Z'),
}

export function relTime(ms: number): string {
  if (!ms) return 'never'
  const d = (Date.now() - ms) / 1000
  if (d < 45) return 'just now'
  if (d < 3600) return `${Math.round(d / 60)} min ago`
  if (d < 86400) return `${Math.round(d / 3600)} h ago`
  return `${Math.round(d / 86400)} d ago`
}

export function plural(n: number, w: string, ws = `${w}s`) {
  return `${n} ${n === 1 ? w : ws}`
}
