import { describe, expect, it } from 'vitest'
import { addNote, answer, buildQueue, createDeck, deleteNote, updateNote } from '../src/lib/ops'
import { exportBackup, importBackup } from '../src/lib/platform'
import { Store } from '../src/lib/store'
import { SyncEngine, type SyncMsg, type Transport } from '../src/lib/sync/engine'
import { timing } from '../src/lib/scheduler/timing'

/** In-memory network: deliver messages asynchronously, in order, like a data channel. */
class Net {
  nodes = new Map<string, Transport>()
  queue: (() => void)[] = []
  online = new Set<string>()
  join(id: string): Transport {
    const t: Transport = {
      send: (peer, msg) => {
        const copy = JSON.parse(JSON.stringify(msg)) as SyncMsg
        this.queue.push(() => this.online.has(peer) && this.online.has(id) && this.nodes.get(peer)?.onMessage?.(id, copy))
      },
      onMessage: null, onPeerJoin: null, onPeerLeave: null,
      leave: () => this.leave(id),
    }
    this.nodes.set(id, t)
    return t
  }
  up(id: string) {
    for (const o of this.online) {
      this.nodes.get(o)!.onPeerJoin?.(id)
      this.nodes.get(id)!.onPeerJoin?.(o)
    }
    this.online.add(id)
  }
  leave(id: string) {
    this.online.delete(id)
    for (const o of this.online) this.nodes.get(o)!.onPeerLeave?.(id)
    this.nodes.get(id)!.onPeerLeave && [...this.online].forEach((o) => this.nodes.get(id)!.onPeerLeave!(o))
  }
  drain() {
    let n = 0
    while (this.queue.length && n++ < 100000) this.queue.shift()!()
  }
}

function device(net: Net, name: string) {
  const s = new Store()
  s.openMemory(name)
  const e = new SyncEngine(s, net.join(name), () => name)
  s.onLocalChange = () => e.localChanged()
  return { s, e }
}

const live = (s: Store) => ({
  decks: s.all('decks').map((d) => d.name).sort(),
  notes: s.all('notes').map((n) => JSON.stringify(n.fields)).sort(),
  cards: s.all('cards').map((c) => `${c.id}:${c.type}:${c.ivl}:${c.reps}`).sort(),
  revlog: s.all('revlog').length,
})

describe('sync engine', () => {
  it('two devices converge, including deletes and concurrent edits', () => {
    const net = new Net()
    const A = device(net, 'A')
    const B = device(net, 'B')
    const deck = createDeck(A.s, 'Spanish')
    const n1 = addNote(A.s, deck.id, 'basic', { front: 'hola', back: 'hello' })
    const n2 = addNote(A.s, deck.id, 'reversed', { front: 'gato', back: 'cat' })
    net.up('A'); net.up('B'); net.drain()
    expect(live(B.s)).toEqual(live(A.s))
    expect(B.s.all('cards')).toHaveLength(3)

    // go offline, edit on both sides
    net.leave('B')
    updateNote(A.s, n1.id, { fields: { front: 'hola', back: 'hi (A)' } })
    deleteNote(A.s, n2.id)
    const t = timing()
    answer(B.s, `${n1.id}.0`, 3, 1000, t)
    addNote(B.s, deck.id, 'cloze', { text: '{{c1::Madrid}} is the capital of {{c2::Spain}}', extra: '' })
    net.up('B'); net.drain()
    expect(live(B.s)).toEqual(live(A.s))
    expect(A.s.all('cards')).toHaveLength(3) // n1 + 2 cloze
    expect(A.s.get('cards', `${n1.id}.0`)!.reps).toBe(1)
    expect(A.s.get('notes', n1.id)!.fields.back).toBe('hi (A)')
    expect(A.s.all('revlog')).toHaveLength(1)
  })

  it('changes hop through an intermediary (A→B→C) without A and C meeting', () => {
    const net = new Net()
    const A = device(net, 'A'), B = device(net, 'B'), C = device(net, 'C')
    const deck = createDeck(A.s, 'Bio')
    for (let i = 0; i < 950; i++) addNote(A.s, deck.id, 'basic', { front: `q${i}`, back: `a${i}` })
    net.up('A'); net.up('B'); net.drain()
    net.leave('A')
    net.up('C'); net.drain()
    expect(live(C.s)).toEqual(live(A.s))
    expect(C.s.all("notes")).toHaveLength(950)
    expect(B.s.all("notes")).toHaveLength(950)
  })

  it('live edits propagate while connected and do not echo forever', async () => {
    const net = new Net()
    const A = device(net, 'A'), B = device(net, 'B')
    net.up('A'); net.up('B'); net.drain()
    createDeck(A.s, 'Live')
    await new Promise((r) => setTimeout(r, 450)) // debounce
    net.drain()
    expect(live(B.s).decks).toEqual(['Live'])
    expect(net.queue.length).toBe(0)
  })

  it('backup file import is a merge', () => {
    const A = new Store(); A.openMemory('A')
    const B = new Store(); B.openMemory('B')
    const d = createDeck(A, 'X')
    addNote(A, d.id, 'basic', { front: '1', back: '2' })
    const n = addNote(B, d.id, 'basic', { front: 'b', back: 'b' })
    expect(importBackup(B, exportBackup(A))).toBe(3)
    expect(B.all('notes')).toHaveLength(2)
    expect(B.get('notes', n.id)).toBeTruthy()
    expect(importBackup(B, exportBackup(A))).toBe(0)
  })
})

describe('queue', () => {
  it('respects new limit and mixes reviews', () => {
    const s = new Store(); s.openMemory('Q')
    const d = createDeck(s, 'D')
    for (let i = 0; i < 30; i++) addNote(s, d.id, 'basic', { front: `${i}`, back: '' })
    const q = buildQueue(s, d.id)
    expect(q.counts.new).toBe(20)
    expect(q.main).toHaveLength(20)
  })
})
