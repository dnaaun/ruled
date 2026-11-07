// Hybrid logical clock: timestamps that sort correctly across devices even with clock skew.
// Encoded as fixed-width strings so plain string comparison == causal order.

const pad = (n: number, w: number) => n.toString(36).padStart(w, '0')

export function encodeHlc(l: number, c: number, node: string) {
  return `${pad(l, 9)}:${pad(c, 5)}:${node}`
}

export function decodeHlc(s: string): { l: number; c: number; node: string } {
  const [l, c, node] = s.split(':')
  return { l: parseInt(l, 36), c: parseInt(c, 36), node }
}

export function hlcNode(s: string) {
  return s.slice(s.lastIndexOf(':') + 1)
}

export class HLC {
  private l = 0
  private c = 0
  constructor(readonly node: string, private wall: () => number = Date.now) {}

  now(): string {
    const pt = this.wall()
    if (pt > this.l) {
      this.l = pt
      this.c = 0
    } else {
      this.c++
    }
    return encodeHlc(this.l, this.c, this.node)
  }

  recv(remote: string) {
    const r = decodeHlc(remote)
    if (!Number.isFinite(r.l)) return
    const pt = this.wall()
    const nl = Math.max(this.l, r.l, pt)
    if (nl === this.l && nl === r.l) this.c = Math.max(this.c, r.c) + 1
    else if (nl === this.l) this.c++
    else if (nl === r.l) this.c = r.c + 1
    else this.c = 0
    this.l = nl
  }
}
