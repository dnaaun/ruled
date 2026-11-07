import { render } from 'preact'
import { App } from './app'
import { store } from './lib/store'
import { sync } from './lib/sync/p2p'
import { isIOS, isMacApp } from './lib/platform'
import './styles.css'

// macOS app: content runs under the transparent title bar, leave room for the traffic lights.
// (Not on iPad, whose user agent also says "Macintosh".)
if (isMacApp) document.documentElement.classList.add('mac-app')
if (isIOS) document.documentElement.classList.add('ios')

async function boot() {
  await store.open()
  // persist before the app is backgrounded/closed (mobile kills webviews without warning)
  const flush = () => void store.flush()
  addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush())
  navigator.storage?.persist?.().catch(() => {})
  render(<App />, document.getElementById('app')!)
  document.getElementById('boot')?.remove()
  sync.start()
}

boot().catch((e) => {
  document.body.innerHTML = `<pre style="padding:24px;white-space:pre-wrap">Ruled couldn't open its database.\n\n${e}</pre>`
})
