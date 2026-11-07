// Port of Anki's rslib/src/scheduler/states/fuzz.rs
// Review intervals are "fuzzed" so cards added together don't stay clumped together forever.

interface FuzzRange { start: number; end: number; factor: number }

const FUZZ_RANGES: FuzzRange[] = [
  { start: 2.5, end: 7.0, factor: 0.15 },
  { start: 7.0, end: 20.0, factor: 0.1 },
  { start: 20.0, end: Number.MAX_VALUE, factor: 0.05 },
]

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/** Rust's f32::round (half away from zero) — identical to Math.round for the positive values we use. */
const round = (v: number) => (v < 0 ? -Math.round(-v) : Math.round(v))

export function fuzzDelta(interval: number): number {
  if (interval < 2.5) return 0
  return FUZZ_RANGES.reduce(
    (delta, r) => delta + r.factor * Math.max(Math.min(interval, r.end) - r.start, 0),
    1.0,
  )
}

export function fuzzBounds(interval: number): [number, number] {
  const delta = fuzzDelta(interval)
  return [Math.max(0, round(interval - delta)), Math.max(0, round(interval + delta))]
}

export function constrainedFuzzBounds(interval: number, minimum: number, maximum: number): [number, number] {
  minimum = Math.min(minimum, maximum)
  interval = clamp(interval, minimum, maximum)
  let [lower, upper] = fuzzBounds(interval)
  lower = clamp(lower, minimum, maximum)
  upper = clamp(upper, minimum, maximum)
  if (upper === lower && upper > 2 && upper < maximum) upper = lower + 1
  return [lower, upper]
}

/** fuzzFactor is a number in [0, 1) seeded per card, or null to disable fuzz. */
export function withReviewFuzz(fuzzFactor: number | null, interval: number, minimum: number, maximum: number): number {
  if (fuzzFactor == null) return clamp(round(interval), minimum, maximum)
  const [lower, upper] = constrainedFuzzBounds(interval, minimum, maximum)
  return Math.floor(lower + fuzzFactor * (1 + upper - lower))
}

/** Anki: add up to 25% to a learning step, but no more than 5 minutes. */
export function withLearningFuzz(secs: number, rand: () => number = Math.random): number {
  const upperExclusive = secs + Math.floor(Math.min(secs * 0.25, 300))
  if (secs >= upperExclusive) return secs
  return secs + Math.floor(rand() * (upperExclusive - secs))
}

/**
 * Deterministic fuzz factor for a card. Anki seeds an RNG with (card id + reps), so the
 * interval shown on the answer button is exactly the one you get. We do the same with a
 * small, well-distributed PRNG (Anki uses Rust's StdRng; the distribution is identical).
 */
export function fuzzFactorFor(cardId: string, reps: number): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < cardId.length; i++) {
    h ^= cardId.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  // splitmix32 over (hash + reps)
  let z = (h + Math.imul(reps + 1, 0x9e3779b9)) >>> 0
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0
  z = (z ^ (z >>> 16)) >>> 0
  return z / 4294967296
}
