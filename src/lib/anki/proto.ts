// Just enough of a protobuf wire-format reader for Anki's schema-18 config blobs and media map.

export type ProtoValue = number | bigint | Uint8Array
/** field number → values in order (repeated fields keep every occurrence) */
export type ProtoMsg = Map<number, ProtoValue[]>

export function decodeProto(buf: Uint8Array): ProtoMsg {
  const out: ProtoMsg = new Map()
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let i = 0
  const varint = (): bigint => {
    let shift = 0n
    let v = 0n
    for (;;) {
      if (i >= buf.length) throw new Error('truncated protobuf')
      const b = buf[i++]
      v |= BigInt(b & 0x7f) << shift
      if (!(b & 0x80)) return v
      shift += 7n
    }
  }
  while (i < buf.length) {
    const key = Number(varint())
    const field = key >>> 3
    const wire = key & 7
    let val: ProtoValue
    if (wire === 0) {
      const v = varint()
      val = v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v
    } else if (wire === 1) {
      val = view.getBigInt64(i, true)
      i += 8
    } else if (wire === 2) {
      const len = Number(varint())
      val = buf.subarray(i, i + len)
      i += len
    } else if (wire === 5) {
      val = view.getFloat32(i, true)
      i += 4
    } else throw new Error(`unsupported protobuf wire type ${wire}`)
    const list = out.get(field)
    if (list) list.push(val)
    else out.set(field, [val])
  }
  return out
}

export const protoNum = (m: ProtoMsg, f: number): number | undefined => {
  const v = m.get(f)?.at(-1)
  if (v == null) return undefined
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  return undefined
}

export const protoBytes = (m: ProtoMsg, f: number): Uint8Array | undefined => {
  const v = m.get(f)?.at(-1)
  return v instanceof Uint8Array ? v : undefined
}

export const protoStr = (m: ProtoMsg, f: number): string | undefined => {
  const b = protoBytes(m, f)
  return b && new TextDecoder().decode(b)
}

/** Repeated float field: packed (one length-delimited blob) or unpacked (one fixed32 per entry). */
export function protoFloats(m: ProtoMsg, f: number): number[] {
  const out: number[] = []
  for (const v of m.get(f) ?? []) {
    if (typeof v === 'number') out.push(v)
    else if (v instanceof Uint8Array) {
      const dv = new DataView(v.buffer, v.byteOffset, v.byteLength)
      for (let j = 0; j + 4 <= v.length; j += 4) out.push(dv.getFloat32(j, true))
    }
  }
  return out
}
