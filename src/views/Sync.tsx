import { useState } from 'preact/hooks'
import { Icon, plural, relTime, toast, useStore, useTick } from '../components/ui'
import { exportBackup, importBackup, isTauri, openTextFile, saveTextFile } from '../lib/platform'
import { newCircleCode, normalizeCode, sync, useSync } from '../lib/sync/p2p'

const devIcon = (name: string) => (/android|phone|pixel|galaxy|iphone/i.test(name) ? <Icon.phone /> : <Icon.laptop />)

export function SyncView() {
  const s = useStore()
  const st = useSync()
  useTick(15_000)
  const [join, setJoin] = useState('')
  const [reveal, setReveal] = useState(false)
  const [name, setName] = useState(st.deviceName)

  const online = new Set(st.peers.map((p) => p.device))
  const known = Object.entries(st.devices).sort((a, b) => b[1].lastSync - a[1].lastSync)

  const doExport = async () => {
    try {
      const ok = await saveTextFile(`ruled-backup-${new Date().toISOString().slice(0, 10)}.json`, exportBackup(s))
      if (ok) toast('Backup saved')
    } catch (e) {
      toast(`Couldn’t save: ${e}`)
    }
  }
  const doImport = async () => {
    try {
      const text = await openTextFile(['json'])
      if (text == null) return
      const n = importBackup(s, text)
      toast(n ? `Merged ${plural(n, 'change')}` : 'Already up to date')
    } catch (e) {
      toast(`Couldn’t import: ${e instanceof Error ? e.message : e}`)
    }
  }

  return (
    <main class="page">
      <p class="eyebrow">Sync</p>
      <h1 class="display" style={{ fontSize: 'clamp(32px, 5vw, 46px)' }}>No server. <em>Just your devices.</em></h1>
      <p class="lede" style={{ marginBottom: '32px' }}>
        Devices in the same sync circle find each other and swap changes directly, whenever two of them are open at once. Edits made offline merge cleanly later.
      </p>

      <div class="syncgrid">
        <section class="panel paper">
          {st.code ? (
            <>
              <div class="row" style={{ justifyContent: 'space-between', marginBottom: '6px' }}>
                <h3>Your sync circle</h3>
                <span class="status">
                  <span class={`syncdot ${st.peers.length ? 'live' : 'wait'}`} />
                  {st.error ? 'trouble connecting' : st.peers.length ? `${plural(st.peers.length, 'device')} online` : 'listening…'}
                </span>
              </div>
              <p>Enter this code on your other devices. Anyone with it can read and change your cards — keep it private.</p>
              <div class={`code ${reveal ? '' : 'blur'}`} onClick={() => setReveal(true)} title={reveal ? '' : 'Click to reveal'}>
                {st.code}
              </div>
              <div class="row" style={{ marginTop: '14px' }}>
                <button class="btn" onClick={() => setReveal(!reveal)}>{reveal ? 'Hide' : 'Reveal'}</button>
                <button class="btn" onClick={async () => {
                  try { await navigator.clipboard.writeText(st.code!); toast('Code copied') } catch { setReveal(true); toast('Select the code to copy it') }
                }}><Icon.copy /> Copy</button>
                <span class="grow" />
                <button class="btn ghost danger" onClick={() => {
                  if (confirm('Leave this sync circle? Your cards stay on this device.')) sync.setCode(null)
                }}>Leave</button>
              </div>
              {st.error && <p class="small" style={{ color: 'var(--learn)', marginTop: '14px', marginBottom: 0 }}>{st.error}</p>}
            </>
          ) : (
            <>
              <div class="diagram">
                <div class="dcard paper ruled" style={{ '--line': '10px', transform: 'rotate(-4deg)' } as any} />
                <div class="wire" />
                <div class="dcard paper ruled" style={{ '--line': '10px', transform: 'rotate(3deg)' } as any} />
              </div>
              <h3>Start a sync circle</h3>
              <p>Creates a private code for this device. Then enter it on your phone or laptop.</p>
              <button class="btn primary" onClick={() => { sync.setCode(newCircleCode()); setReveal(true) }}>Create a circle</button>
              <hr style={{ border: 0, borderTop: '1px dashed var(--edge)', margin: '26px 0' }} />
              <h3>Join an existing circle</h3>
              <p>Already set one up on another device? Type its code.</p>
              <form class="row" onSubmit={(e) => {
                e.preventDefault()
                const c = normalizeCode(join)
                if (!c) return toast('That code doesn’t look right — it’s 20 letters and digits')
                sync.setCode(c)
                setJoin('')
                toast('Joined — looking for your devices')
              }}>
                <input class="input mono grow" style={{ minWidth: '220px', letterSpacing: '0.06em' }} placeholder="XXXXX-XXXXX-XXXXX-XXXXX" value={join} onInput={(e) => setJoin(e.currentTarget.value)} autoCapitalize="characters" autoComplete="off" spellcheck={false} />
                <button class="btn primary" type="submit">Join</button>
              </form>
            </>
          )}
        </section>

        <section class="panel paper">
          <h3>Devices</h3>
          <label class="field" style={{ marginTop: '14px' }}>
            <span>This device is called</span>
            <input class="input" value={name} onInput={(e) => setName(e.currentTarget.value)} onBlur={() => sync.rename(name)} onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} />
          </label>
          {known.length === 0 ? (
            <p class="small muted" style={{ margin: 0 }}>{st.code ? 'No other devices seen yet. Open Ruled on another device in this circle.' : 'Join a circle to see your other devices here.'}</p>
          ) : (
            <ul class="devices">
              {known.map(([dev, d]) => {
                const peer = st.peers.find((p) => p.device === dev)
                return (
                  <li>
                    <span class="dev">{devIcon(d.name)}</span>
                    <span class="grow">
                      <b>{d.name}</b>
                      <small>{peer ? (peer.syncing ? 'syncing…' : 'online · in sync') : `last synced ${relTime(d.lastSync)}`}</small>
                    </span>
                    <span class={`syncdot ${online.has(dev) ? 'live' : ''}`} />
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section class="panel paper">
          <h3>Backup file</h3>
          <p>
            A single file with everything, including deletions. Importing one <i>merges</i> it — nothing is overwritten that’s newer here.
            Handy for an iCloud, Syncthing or USB-stick hop when two devices are never online together.
          </p>
          <div class="row">
            <button class="btn" onClick={doExport}><Icon.download /> Export backup</button>
            <button class="btn" onClick={doImport}><Icon.upload /> Import &amp; merge</button>
          </div>
        </section>

        <section class="panel paper">
          <h3>How it works</h3>
          <ol class="howto" style={{ paddingLeft: '18px', margin: 0 }}>
            <li>Your cards live in this {isTauri ? 'app' : 'browser'}’s local database. Ruled works fully offline.</li>
            <li>The circle code is hashed into a meeting point. Devices announce themselves through public Nostr relays, with the handshake encrypted by your code.</li>
            <li>Card data never touches the relays: it goes device-to-device over an encrypted WebRTC channel.</li>
            <li>Every change is stamped with a hybrid logical clock; the newest edit wins and review history is merged, so nothing is lost.</li>
          </ol>
        </section>
      </div>
    </main>
  )
}
