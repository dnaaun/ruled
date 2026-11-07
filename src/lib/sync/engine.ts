// Peer-to-peer replication of the record log.
//
// Every record carries an HLC stamp (last-writer-wins) and a local sequence number that increases
// whenever that record changes on this device (local edit OR merged from a peer). A device asks a
// peer for "everything you changed after <cursor>", applies it, and advances its cursor for that
// peer. Because merges also bump local sequence numbers, changes flow transitively A → B → C even
// when A and C are never online together. Merging is idempotent and commutative, so duplicated or
// re-ordered deliveries are harmless.

import { hlcNode } from '../hlc'
import type { Base, Table } from '../model'
import type { Store } from '../store'

export type SyncMsg =
  | { t: 'hi'; v: 1; device: string; name: string }
  | { t: 'pull'; since: number }
  | { t: 'batch'; recs: [Table, Base][]; upTo: number; done: boolean; total: number }
  | { t: 'poke' }

export interface Transport {
  send(peer: string, msg: SyncMsg): void
  onMessage: ((peer: string, msg: SyncMsg) => void) | null
  onPeerJoin: ((peer: string) => void) | null
  onPeerLeave: ((peer: string) => void) | null
  leave(): void
}

export interface KnownDevice { name: string; lastSync: number; cursor: number }

export interface SyncStatus {
  peers: { peer: string; device: string; name: string; syncing: boolean }[]
  devices: Record<string, KnownDevice>
  lastSync: number
  received: number
}

const BATCH = 400

export class SyncEngine {
  private peerDevice = new Map<string, { device: string; name: string }>()
  private syncing = new Set<string>()
  private pokeTimer: ReturnType<typeof setTimeout> | null = null
  devices: Record<string, KnownDevice>
  received = 0
  onStatus: ((s: SyncStatus) => void) | null = null

  constructor(
    private store: Store,
    private transport: Transport,
    private deviceName: () => string,
  ) {
    this.devices = { ...(store.getKv<Record<string, KnownDevice>>('syncDevices') ?? {}) }
    transport.onPeerJoin = (p) => this.send(p, { t: 'hi', v: 1, device: store.deviceId, name: this.deviceName() })
    transport.onPeerLeave = (p) => {
      this.peerDevice.delete(p)
      this.syncing.delete(p)
      this.emit()
    }
    transport.onMessage = (p, m) => this.handle(p, m)
  }

  /** Call after local edits; debounced. */
  localChanged() {
    if (this.pokeTimer) clearTimeout(this.pokeTimer)
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = null
      for (const p of this.peerDevice.keys()) this.send(p, { t: 'poke' })
    }, 400)
  }

  /** Re-announce to every peer (e.g. after rename). */
  hello() {
    for (const p of this.peerDevice.keys()) this.send(p, { t: 'hi', v: 1, device: this.store.deviceId, name: this.deviceName() })
  }

  status(): SyncStatus {
    const lastSync = Math.max(0, ...Object.values(this.devices).map((d) => d.lastSync))
    return {
      peers: [...this.peerDevice.entries()].map(([peer, d]) => ({ peer, ...d, syncing: this.syncing.has(peer) })),
      devices: this.devices,
      lastSync,
      received: this.received,
    }
  }

  stop() {
    if (this.pokeTimer) clearTimeout(this.pokeTimer)
    this.transport.leave()
  }

  private emit() {
    this.onStatus?.(this.status())
  }

  private send(peer: string, msg: SyncMsg) {
    try {
      this.transport.send(peer, msg)
    } catch (e) {
      console.warn('sync send failed', e)
    }
  }

  private saveDevices() {
    this.store.setKv('syncDevices', this.devices)
  }

  private handle(peer: string, msg: SyncMsg) {
    if (!msg || typeof msg !== 'object') return
    switch (msg.t) {
      case 'hi': {
        if (typeof msg.device !== 'string' || msg.device === this.store.deviceId) return
        const first = !this.peerDevice.has(peer)
        this.peerDevice.set(peer, { device: msg.device, name: String(msg.name ?? 'Device').slice(0, 60) })
        const d = this.devices[msg.device] ?? { name: msg.name, lastSync: 0, cursor: 0 }
        d.name = String(msg.name ?? d.name)
        this.devices[msg.device] = d
        this.saveDevices()
        // answer a first hi so both sides learn each other's device id
        if (first) {
          this.send(peer, { t: 'hi', v: 1, device: this.store.deviceId, name: this.deviceName() })
          this.pull(peer)
        }
        this.emit()
        return
      }
      case 'poke':
        this.pull(peer)
        return
      case 'pull':
        this.serve(peer, Number(msg.since) || 0)
        return
      case 'batch': {
        const info = this.peerDevice.get(peer)
        if (!info || !Array.isArray(msg.recs)) return
        const changed = this.store.merge(msg.recs)
        this.received += changed
        const d = this.devices[info.device]
        d.cursor = Math.max(d.cursor, Number(msg.upTo) || 0)
        if (msg.done) {
          d.lastSync = Date.now()
          this.syncing.delete(peer)
        }
        this.saveDevices()
        // pass what we just learned along to everyone else
        if (changed) for (const p of this.peerDevice.keys()) if (p !== peer) this.send(p, { t: 'poke' })
        this.emit()
        return
      }
    }
  }

  private pull(peer: string) {
    const info = this.peerDevice.get(peer)
    if (!info) return
    this.syncing.add(peer)
    this.send(peer, { t: 'pull', since: this.devices[info.device]?.cursor ?? 0 })
    this.emit()
  }

  private serve(peer: string, since: number) {
    const info = this.peerDevice.get(peer)
    if (!info) return
    const snapshot = this.store.seq
    // skip versions the requester itself authored — it already has them (or something newer)
    const recs = this.store.changesSince(since).filter(([, r]) => hlcNode(r.hlc) !== info.device)
    if (!recs.length) {
      this.send(peer, { t: 'batch', recs: [], upTo: snapshot, done: true, total: 0 })
      return
    }
    for (let i = 0; i < recs.length; i += BATCH) {
      const chunk = recs.slice(i, i + BATCH)
      const last = i + BATCH >= recs.length
      this.send(peer, {
        t: 'batch',
        recs: chunk,
        upTo: last ? snapshot : chunk[chunk.length - 1][1].seq,
        done: last,
        total: recs.length,
      })
    }
  }
}
