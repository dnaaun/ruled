import { useEffect, useState } from 'preact/hooks'
import { Icon, Toaster, useRoute } from './components/ui'
import { useSync } from './lib/sync/p2p'
import { Browse } from './views/Browse'
import { DeckView } from './views/DeckView'
import { Decks } from './views/Decks'
import { Editor } from './views/Editor'
import { Options } from './views/Options'
import { Stats } from './views/Stats'
import { Study } from './views/Study'
import { SyncView } from './views/Sync'

type Theme = 'auto' | 'light' | 'dark'

function useTheme(): [Theme, () => void] {
  const [theme, set] = useState<Theme>(() => {
    try { return (localStorage.getItem('theme') as Theme) || 'auto' } catch { return 'auto' }
  })
  useEffect(() => {
    if (theme === 'auto') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
    try { localStorage.setItem('theme', theme) } catch {}
  }, [theme])
  const dark = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches)
  return [theme, () => set(dark ? 'light' : 'dark')]
}

const TABS = [
  ['', 'Stacks', Icon.stacks],
  ['browse', 'Browse', Icon.search],
  ['stats', 'Stats', Icon.chart],
  ['sync', 'Sync', Icon.sync],
] as const

export function App() {
  const { path, query } = useRoute()
  const [, toggleTheme] = useTheme()
  const st = useSync()
  const [head, a, ] = path

  if (head === 'study' && a) {
    return <><Study id={a} key={a} /><Toaster /></>
  }

  let view
  switch (head) {
    case 'deck': view = <DeckView id={a} key={a} />; break
    case 'add': view = <Editor deckId={a} key={`add-${a}`} back={query.get('back') ?? undefined} />; break
    case 'edit': view = <Editor noteId={a} key={`edit-${a}`} back={query.get('back') ?? undefined} />; break
    case 'browse': view = <Browse deckId={query.get('deck') ?? undefined} key={query.get('deck') ?? ''} />; break
    case 'options': view = <Options id={a} key={a} />; break
    case 'stats': view = <Stats deckId={query.get('deck') ?? undefined} />; break
    case 'sync': view = <SyncView />; break
    default: view = <Decks />
  }
  const active = head === 'deck' || head === 'add' || head === 'options' || !head ? '' : head === 'edit' ? 'browse' : head
  const dot = st.code ? (st.peers.length ? 'live' : 'wait') : ''

  return (
    <div class="shell">
      <header class="topbar" data-tauri-drag-region>
        <a class="wordmark" href="#/"><span class="mark" />Ruled</a>
        <nav class="nav">
          {TABS.map(([p, l]) => (
            <a href={`#/${p}`} class={active === p ? 'on' : ''}>
              {l}{p === 'sync' && dot && <span class={`syncdot ${dot}`} />}
            </a>
          ))}
        </nav>
        <span class="spacer" />
        <button class="iconbtn" onClick={toggleTheme} title="Toggle light / dark"><Icon.moon /></button>
      </header>
      {view}
      <nav class="tabbar">
        {TABS.map(([p, l, I]) => (
          <a href={`#/${p}`} class={active === p ? 'on' : ''}>
            <I />
            <span>{l}{p === 'sync' && dot && <span class={`syncdot ${dot}`} style={{ marginLeft: '4px' }} />}</span>
          </a>
        ))}
      </nav>
      <Toaster />
    </div>
  )
}
