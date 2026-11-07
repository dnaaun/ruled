// Sync "circle" over WebRTC. Peers find each other through public Nostr relays (via trystero) —
// the relays only ever see an encrypted handshake for a room name derived from your secret code.
// All card data flows directly device-to-device over an encrypted WebRTC data channel.

import { useEffect, useState } from 'preact/hooks'
import { store } from '../store'
import { SyncEngine, type SyncMsg, type SyncStatus, type Transport } from './engine'

const APP_ID = 'ruled-notecards-v1'
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32

export function newCircleCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % 32]).join('')
  return chars.match(/.{5}/g)!.join('-')
}

export function normalizeCode(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V')
    .replace(/[^0-9A-Z]/g, '')
  if (s.length !== 20 || [...s].some((c) => !CODE_ALPHABET.includes(c))) return null
  return s.match(/.{5}/g)!.join('-')
}

async function sha256(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface TurnSettings { urls: string; username: string; credential: string }

export function turnServers(t: TurnSettings | undefined): RTCIceServer[] {
  if (!t?.urls?.trim()) return []
  const urls = t.urls.split(/[\s,]+/).map((u) => u.trim()).filter((u) => /^turns?:/.test(u))
  return urls.length ? [{ urls, username: t.username || undefined, credential: t.credential || undefined }] : []
}

function friendlyError(raw: string): string {
  if (/after exchanging SDP|TURN/i.test(raw)) {
    return 'Found another device, but couldn’t open a direct connection to it. This happens when the devices are on different networks behind strict routers (common on cellular data and some office or campus Wi-Fi). Put both on the same Wi-Fi, or add a TURN relay below.'
  }
  if (/password|decrypt/i.test(raw)) return 'Another device is using a different code for this circle.'
  if (/handshake|timeout/i.test(raw)) return 'Found another device, but it didn’t answer in time. It will retry automatically.'
  return raw
}

async function trysteroTransport(code: string, onError: (e: string) => void, turn: RTCIceServer[]): Promise<Transport> {
  const { joinRoom } = await import('trystero')
  const secret = code.replace(/-/g, '')
  const roomId = (await sha256(`room:${secret}`)).slice(0, 40)
  const password = await sha256(`key:${secret}`)
  // Optional: your own Nostr relays (Settings → Advanced isn't needed for most people)
  let relayUrls: string[] | undefined
  try {
    const raw = localStorage.getItem('ruled:relays')
    if (raw) relayUrls = raw.split(/[\s,]+/).filter((u) => /^wss?:\/\//.test(u))
  } catch {}
  const room = joinRoom({
    appId: APP_ID,
    password,
    ...(relayUrls?.length ? { relayConfig: { urls: relayUrls } } : {}),
    ...(turn.length ? { turnConfig: turn } : {}),
  }, roomId, {
    onJoinError: (d: { error?: unknown }) => onError(friendlyError(String(d?.error ?? 'Could not connect to a device'))),
  } as never)
  const action = room.makeAction<any>('sync')
  const t: Transport = {
    send: (peer, msg) => void action.send(msg as never, { target: peer }).catch(() => {}),
    onMessage: null,
    onPeerJoin: null,
    onPeerLeave: null,
    leave: () => void room.leave(),
  }
  action.onMessage = (data: unknown, ctx: { peerId: string }) => t.onMessage?.(ctx.peerId, data as SyncMsg)
  room.onPeerJoin = (p) => t.onPeerJoin?.(p)
  room.onPeerLeave = (p) => t.onPeerLeave?.(p)
  return t
}

// ---------------------------------------------------------------- app-level manager

export interface SyncState extends SyncStatus {
  code: string | null
  active: boolean
  error: string | null
  deviceName: string
}

class SyncManager {
  private engine: SyncEngine | null = null
  private listeners = new Set<(s: SyncState) => void>()
  error: string | null = null

  get code() { return store.getKv<string>('syncCode') ?? null }
  get deviceName() { return store.getKv<string>('deviceName') ?? defaultDeviceName() }

  state(): SyncState {
    const base = this.engine?.status() ?? {
      peers: [],
      devices: store.getKv<Record<string, any>>('syncDevices') ?? {},
      lastSync: 0,
      received: 0,
    }
    if (!this.engine) base.lastSync = Math.max(0, ...Object.values(base.devices).map((d: any) => d.lastSync ?? 0))
    return { ...base, code: this.code, active: !!this.engine, error: this.error, deviceName: this.deviceName }
  }

  subscribe(fn: (s: SyncState) => void) {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  private emit() {
    const s = this.state()
    for (const fn of this.listeners) fn(s)
  }

  async start() {
    const code = this.code
    if (!code || this.engine) return
    if (typeof RTCPeerConnection === 'undefined') {
      this.error = 'This webview has no WebRTC support — use backup files to move data.'
      this.emit()
      return
    }
    try {
      const transport = await trysteroTransport(code, (e) => {
        this.error = e
        this.emit()
      }, turnServers(this.turn))
      this.engine = new SyncEngine(store, transport, () => this.deviceName)
      this.engine.onStatus = () => {
        this.error = null
        this.emit()
      }
      store.onLocalChange = () => this.engine?.localChanged()
      this.error = null
    } catch (e) {
      this.error = String(e)
    }
    this.emit()
  }

  async stop() {
    this.engine?.stop()
    this.engine = null
    store.onLocalChange = null
    this.emit()
  }

  async setCode(code: string | null) {
    await this.stop()
    store.setKv('syncCode', code)
    if (!code) store.setKv('syncDevices', {})
    await this.start()
  }

  get turn(): TurnSettings {
    return store.getKv<TurnSettings>('turn') ?? { urls: '', username: '', credential: '' }
  }

  /** Save TURN relay settings (this device only) and reconnect. */
  async setTurn(t: TurnSettings) {
    store.setKv('turn', { urls: t.urls.trim(), username: t.username.trim(), credential: t.credential.trim() })
    await this.stop()
    this.error = null
    await this.start()
  }

  rename(name: string) {
    store.setKv('deviceName', name.trim().slice(0, 40) || defaultDeviceName())
    this.engine?.hello()
    this.emit()
  }
}

function defaultDeviceName() {
  const ua = navigator.userAgent
  if (/Android/i.test(ua)) return 'Android'
  if (/iPhone|iPad/i.test(ua)) return 'iPhone'
  if (/Mac/i.test(ua)) return 'Mac'
  if (/Windows/i.test(ua)) return 'Windows PC'
  return 'This device'
}

export const sync = new SyncManager()

export function useSync(): SyncState {
  const [s, set] = useState(() => sync.state())
  useEffect(() => sync.subscribe(set), [])
  return s
}
