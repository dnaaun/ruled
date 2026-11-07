import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type Card } from '../src/lib/model'
import { answerCard, buttonInterval, cardState, formatInterval, stateContext } from '../src/lib/scheduler/answer'
import { constrainedFuzzBounds, fuzzDelta, withLearningFuzz, withReviewFuzz } from '../src/lib/scheduler/fuzz'
import { LearningSteps, nextStates, type ReviewState, type StateContext } from '../src/lib/scheduler/states'
import { timing } from '../src/lib/scheduler/timing'

const ctx = (over: Partial<StateContext> = {}): StateContext => ({
  ...stateContext(DEFAULT_CONFIG, { id: 'x', reps: 0 } as Card, false),
  ...over,
})

const card = (over: Partial<Card> = {}): Card => ({
  id: 'c1', hlc: '', seq: 0, noteId: 'n', deckId: 'd', ord: 0, type: 0, queue: 0, due: 0, ivl: 0,
  factor: 0, reps: 0, lapses: 0, left: 0, stepSecs: 0, created: 0, ...over,
})

describe('learning steps (steps.rs)', () => {
  it('matches Anki defaults 1m 10m', () => {
    const s = new LearningSteps([1, 10])
    expect(s.againDelaySecsLearn()).toBe(60)
    expect(s.hardDelaySecs(2)).toBe(330) // avg of 1m and 10m
    expect(s.goodDelaySecs(2)).toBe(600)
    expect(s.remainingForGood(2)).toBe(1)
    expect(s.hardDelaySecs(1)).toBe(600)
    expect(s.goodDelaySecs(1)).toBe(null)
  })
  it('single step hard is 1.5x, capped at +1 day', () => {
    expect(new LearningSteps([10]).hardDelaySecs(1)).toBe(900)
    expect(new LearningSteps([60 * 24 * 3]).hardDelaySecs(1)).toBe(86400 * 4)
  })
  it('more remaining than steps clamps to first step', () => {
    expect(new LearningSteps([1, 10]).goodDelaySecs(5)).toBe(600)
  })
})

describe('new card (Anki default preset)', () => {
  const st = nextStates({ kind: 'new' }, ctx())
  it('again 1m, hard 5.5m, good 10m, easy 4d', () => {
    expect(st.again).toMatchObject({ kind: 'learn', scheduledSecs: 60, remainingSteps: 2 })
    expect(st.hard).toMatchObject({ kind: 'learn', scheduledSecs: 330, remainingSteps: 2 })
    expect(st.good).toMatchObject({ kind: 'learn', scheduledSecs: 600, remainingSteps: 1 })
    expect(st.easy).toMatchObject({ kind: 'review', scheduledDays: 4, easeFactor: 2.5 })
  })
  it('button labels look like Anki', () => {
    const t = timing(new Date(2026, 0, 10, 12).getTime())
    expect(formatInterval(buttonInterval(st.again, t), true)).toBe('<1m')
    expect(formatInterval(buttonInterval(st.hard, t), true)).toBe('<6m')
    expect(formatInterval(buttonInterval(st.good, t), true)).toBe('<10m')
    expect(formatInterval(buttonInterval(st.easy, t), true)).toBe('4d')
  })
  it('graduates on the last step', () => {
    const s2 = nextStates({ kind: 'learn', remainingSteps: 1, scheduledSecs: 600 }, ctx())
    expect(s2.good).toMatchObject({ kind: 'review', scheduledDays: 1, easeFactor: 2.5 })
    expect(s2.hard).toMatchObject({ kind: 'learn', scheduledSecs: 600 })
    expect(s2.again).toMatchObject({ kind: 'learn', scheduledSecs: 60, remainingSteps: 2 })
  })
})

describe('review card', () => {
  const rev = (over: Partial<ReviewState> = {}): ReviewState => ({
    kind: 'review', scheduledDays: 10, elapsedDays: 10, easeFactor: 2.5, lapses: 0, leeched: false, ...over,
  })
  it('on time, no fuzz: hard 12, good 25, easy 33', () => {
    const st = nextStates(rev(), ctx())
    expect(st.hard).toMatchObject({ scheduledDays: 12, easeFactor: 2.35 })
    expect(st.good).toMatchObject({ scheduledDays: 25, easeFactor: 2.5 })
    expect(st.easy).toMatchObject({ scheduledDays: 33, easeFactor: 2.65 })
  })
  it('late reviews get credit for the delay', () => {
    const st = nextStates(rev({ elapsedDays: 14 }), ctx())
    expect((st.hard as ReviewState).scheduledDays).toBe(12)
    expect((st.good as ReviewState).scheduledDays).toBe(30) // (10 + 4/2) * 2.5
    expect((st.easy as ReviewState).scheduledDays).toBe(46) // (10 + 4) * 2.5 * 1.3 = 45.5
  })
  it('again: relearn 10m, ease -0.2, lapse interval 1d', () => {
    const st = nextStates(rev(), ctx())
    expect(st.again).toMatchObject({
      kind: 'relearn',
      learning: { scheduledSecs: 600, remainingSteps: 1 },
      review: { scheduledDays: 1, easeFactor: 2.3, lapses: 1 },
    })
  })
  it('ease never drops below 130%', () => {
    const st = nextStates(rev({ easeFactor: 1.3 }), ctx())
    expect((st.hard as ReviewState).easeFactor).toBe(1.3)
  })
  it('small intervals: good is always at least hard + 1', () => {
    const st = nextStates(rev({ scheduledDays: 1, elapsedDays: 1 }), ctx())
    expect((st.hard as ReviewState).scheduledDays).toBe(2)
    expect((st.good as ReviewState).scheduledDays).toBe(3)
    expect((st.easy as ReviewState).scheduledDays).toBe(4)
  })
  it('leech at 8 lapses, then every 4', () => {
    const lapse = (n: number) => (nextStates(rev({ lapses: n - 1 }), ctx()) as any).again.review.leeched
    expect([7, 8, 9, 11, 12, 16].map(lapse)).toEqual([false, true, false, false, true, true])
  })
  it('relearning: good returns to the lapse interval, easy adds a day', () => {
    const st = nextStates(
      { kind: 'relearn', learning: { kind: 'learn', remainingSteps: 1, scheduledSecs: 600 }, review: rev({ scheduledDays: 1, easeFactor: 2.3, lapses: 1 }) },
      ctx(),
    )
    expect(st.good).toMatchObject({ kind: 'review', scheduledDays: 1 })
    expect(st.easy).toMatchObject({ kind: 'review', scheduledDays: 2 })
    expect(st.again).toMatchObject({ kind: 'relearn', learning: { scheduledSecs: 600 } })
  })
  it('max interval caps everything', () => {
    const st = nextStates(rev({ scheduledDays: 300, elapsedDays: 300 }), ctx({ maximumReviewInterval: 365 }))
    expect((st.easy as ReviewState).scheduledDays).toBe(365)
  })
})

describe('fuzz (fuzz.rs)', () => {
  it('delta matches Anki ranges', () => {
    expect(fuzzDelta(2)).toBe(0)
    expect(fuzzDelta(5)).toBeCloseTo(1 + 0.15 * 2.5)
    expect(fuzzDelta(25)).toBeCloseTo(1 + 0.15 * 4.5 + 0.1 * 13 + 0.05 * 5)
  })
  it('bounds', () => {
    expect(constrainedFuzzBounds(25, 1, 36500)).toEqual([22, 28])
    expect(constrainedFuzzBounds(12, 11, 36500)).toEqual([11, 14])
    expect(constrainedFuzzBounds(1, 1, 36500)).toEqual([1, 1])
    expect(constrainedFuzzBounds(3, 1, 36500)).toEqual([2, 4])
  })
  it('fuzzed value stays within bounds and covers them', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 1000; i++) seen.add(withReviewFuzz(i / 1000, 25, 1, 36500))
    expect([...seen].sort((a, b) => a - b)).toEqual([22, 23, 24, 25, 26, 27, 28])
  })
  it('learning fuzz: up to 25%, max 5 minutes', () => {
    expect(withLearningFuzz(60, () => 0.999)).toBe(74)
    expect(withLearningFuzz(3600, () => 0.999)).toBe(3899)
    expect(withLearningFuzz(60, () => 0)).toBe(60)
  })
})

describe('answering applies state to the card', () => {
  const t = timing(new Date(2026, 0, 10, 12).getTime())
  it('new → learning → review', () => {
    let c = card()
    let r = answerCard(c, DEFAULT_CONFIG, 3, t, 1000, { fuzz: false, rand: () => 0 })
    c = r.card
    expect(c).toMatchObject({ type: 1, queue: 1, left: 1, due: t.now + 600, reps: 1 })
    expect(r.revlog).toMatchObject({ kind: 0, ivl: -600, lastIvl: 0, from: 'new' })
    r = answerCard(c, DEFAULT_CONFIG, 3, t, 1000, { fuzz: false, rand: () => 0 })
    c = r.card
    expect(c).toMatchObject({ type: 2, queue: 2, ivl: 1, due: t.today + 1, factor: 2500, left: 0 })
    expect(r.revlog).toMatchObject({ kind: 0, ivl: 1, lastIvl: -600, factor: 2500, from: 'learn' })
  })
  it('review lapse → relearning; leech suspends if configured', () => {
    const c = card({ type: 2, queue: 2, ivl: 20, due: t.today, factor: 2500, lapses: 7, reps: 12 })
    expect(cardState(c, t)).toMatchObject({ kind: 'review', elapsedDays: 20 })
    const r = answerCard(c, { ...DEFAULT_CONFIG, leechAction: 'suspend' }, 1, t, 1000, { fuzz: false, rand: () => 0 })
    expect(r.leeched).toBe(true)
    expect(r.card).toMatchObject({ type: 3, queue: 1, ivl: 1, factor: 2300, lapses: 8, suspended: true })
    expect(r.revlog).toMatchObject({ kind: 1, ivl: -600, lastIvl: 20 })
  })
  it('a learning step past the day rollover becomes an interday learning card', () => {
    const cfg = { ...DEFAULT_CONFIG, learnSteps: [10, 1440] }
    const r = answerCard(card(), cfg, 3, t, 1000, { fuzz: false })
    expect(r.card).toMatchObject({ queue: 3, due: t.today + 1 })
  })
  it('fuzz is deterministic: button preview equals the actual answer', () => {
    const c = card({ id: 'abc', type: 2, queue: 2, ivl: 30, due: t.today, factor: 2500, reps: 9 })
    const a = answerCard(c, DEFAULT_CONFIG, 3, t, 0).card.ivl
    const b = answerCard(c, DEFAULT_CONFIG, 3, t, 0).card.ivl
    expect(a).toBe(b)
    expect(a).toBeGreaterThanOrEqual(71)
    expect(a).toBeLessThanOrEqual(79)
  })
})
