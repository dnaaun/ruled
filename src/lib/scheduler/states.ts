// Port of Anki's v3 scheduler state machine (SM-2 variant):
//   rslib/src/scheduler/states/{steps,new,learning,review,relearning}.rs
// Names and structure intentionally mirror the Rust source so the two can be compared line by line.

import { withReviewFuzz } from './fuzz'

export const DAY = 86_400

export const INITIAL_EASE_FACTOR = 2.5
export const MINIMUM_EASE_FACTOR = 1.3
export const EASE_FACTOR_AGAIN_DELTA = -0.2
export const EASE_FACTOR_HARD_DELTA = -0.15
export const EASE_FACTOR_EASY_DELTA = 0.15

export interface NewState { kind: 'new' }
export interface LearnState { kind: 'learn'; remainingSteps: number; scheduledSecs: number }
export interface ReviewState {
  kind: 'review'
  scheduledDays: number
  elapsedDays: number
  easeFactor: number
  lapses: number
  leeched: boolean
}
export interface RelearnState { kind: 'relearn'; learning: LearnState; review: ReviewState }
export type CardState = NewState | LearnState | ReviewState | RelearnState

export interface SchedulingStates {
  current: CardState
  again: CardState
  hard: CardState
  good: CardState
  easy: CardState
}

export interface StateContext {
  /** learning steps, in minutes */
  steps: number[]
  /** relearning steps, in minutes */
  relearnSteps: number[]
  graduatingIntervalGood: number
  graduatingIntervalEasy: number
  initialEaseFactor: number
  hardMultiplier: number
  easyMultiplier: number
  intervalMultiplier: number
  maximumReviewInterval: number
  lapseMultiplier: number
  minimumLapseInterval: number
  leechThreshold: number
  /** [0,1) or null for no fuzz */
  fuzzFactor: number | null
}

// ---------------------------------------------------------------- steps.rs

const toSecs = (minutes: number) => Math.floor(minutes * 60 + 1e-7)

export class LearningSteps {
  constructor(private steps: number[]) {}

  private secsAtIndex(index: number): number | null {
    return index < this.steps.length ? toSecs(this.steps[index]) : null
  }

  /** Cards are allowed to have more remaining steps than there are steps (eg after a config change). */
  private getIndex(remaining: number): number {
    const total = this.steps.length
    return Math.min(Math.max(total - (remaining % 1000), 0), Math.max(total - 1, 0))
  }

  againDelaySecsLearn() { return this.secsAtIndex(0) }
  againDelaySecsRelearn() { return this.secsAtIndex(0) }

  hardDelaySecs(remaining: number): number | null {
    const idx = this.getIndex(remaining)
    const current = this.secsAtIndex(idx)
    if (current == null) return null
    if (idx === 0) return this.hardDelaySecsForFirstStep(current)
    return current
  }

  private hardDelaySecsForFirstStep(againSecs: number): number {
    const next = this.secsAtIndex(1)
    if (next != null) {
      // average of first (again) and second (good) steps
      return Math.floor((againSecs + next) / 2)
    }
    // 50% more than the again secs, but at most one day more; otherwise a learning step of
    // 3 days and a graduating interval of 4 days would make hard larger than good
    const secs = Math.floor(againSecs * 1.5)
    return Math.min(secs, againSecs + DAY)
  }

  goodDelaySecs(remaining: number): number | null {
    return this.secsAtIndex(this.getIndex(remaining) + 1)
  }

  currentDelaySecs(remaining: number): number | null {
    return this.secsAtIndex(this.getIndex(remaining))
  }

  remainingForGood(remaining: number): number {
    const idx = this.getIndex(remaining)
    return Math.max(this.steps.length - (idx + 1), 0)
  }

  remainingForFailed(): number {
    return this.steps.length
  }
}

// ---------------------------------------------------------------- helpers

function minAndMaxReviewIntervals(ctx: StateContext, minimum: number): [number, number] {
  const maximum = Math.max(ctx.maximumReviewInterval, 1)
  return [Math.min(Math.max(minimum, 1), maximum), maximum]
}

function leechThresholdMet(lapses: number, threshold: number): boolean {
  if (threshold <= 0) return false
  const halfThreshold = Math.max(Math.ceil(threshold / 2), 1)
  // at threshold, and every half threshold after that, rounding up
  return lapses >= threshold && (lapses - threshold) % halfThreshold === 0
}

/**
 * Transform the provided hard/good/easy interval:
 * apply interval multiplier, apply fuzz, ensure >= minimum and >= 1, ensure <= maximum.
 */
function constrainPassingInterval(ctx: StateContext, interval: number, minimum: number, fuzz: boolean): number {
  interval = interval * ctx.intervalMultiplier
  const [min, max] = minAndMaxReviewIntervals(ctx, minimum)
  if (fuzz) return withReviewFuzz(ctx.fuzzFactor, interval, min, max)
  return Math.min(Math.max(Math.round(interval), min), max)
}

// ---------------------------------------------------------------- new.rs

export function newNextStates(ctx: StateContext): SchedulingStates {
  const steps = new LearningSteps(ctx.steps)
  const learn: LearnState = { kind: 'learn', remainingSteps: steps.remainingForFailed(), scheduledSecs: 0 }
  return { ...learningNextStates(learn, ctx), current: { kind: 'new' } }
}

// ---------------------------------------------------------------- learning.rs

function graduateGood(ctx: StateContext): ReviewState {
  const [minimum, maximum] = minAndMaxReviewIntervals(ctx, 1)
  return {
    kind: 'review',
    scheduledDays: withReviewFuzz(ctx.fuzzFactor, ctx.graduatingIntervalGood, minimum, maximum),
    elapsedDays: 0,
    easeFactor: ctx.initialEaseFactor,
    lapses: 0,
    leeched: false,
  }
}

export function learningNextStates(state: LearnState, ctx: StateContext): SchedulingStates {
  const steps = new LearningSteps(ctx.steps)

  const again = ((): CardState => {
    const delay = steps.againDelaySecsLearn()
    if (delay == null) return graduateGood(ctx)
    return { kind: 'learn', remainingSteps: steps.remainingForFailed(), scheduledSecs: delay }
  })()

  const hard = ((): CardState => {
    const delay = steps.hardDelaySecs(state.remainingSteps)
    if (delay == null) return graduateGood(ctx)
    return { kind: 'learn', remainingSteps: state.remainingSteps, scheduledSecs: delay }
  })()

  const good = ((): CardState => {
    const delay = steps.goodDelaySecs(state.remainingSteps)
    if (delay == null) return graduateGood(ctx)
    return { kind: 'learn', remainingSteps: steps.remainingForGood(state.remainingSteps), scheduledSecs: delay }
  })()

  const easy = ((): ReviewState => {
    let [minimum, maximum] = minAndMaxReviewIntervals(ctx, 1)
    const goodIvl = withReviewFuzz(ctx.fuzzFactor, ctx.graduatingIntervalGood, minimum, maximum)
    minimum = goodIvl + 1
    return {
      kind: 'review',
      scheduledDays: withReviewFuzz(ctx.fuzzFactor, ctx.graduatingIntervalEasy, minimum, maximum),
      elapsedDays: 0,
      easeFactor: ctx.initialEaseFactor,
      lapses: 0,
      leeched: false,
    }
  })()

  return { current: state, again, hard, good, easy }
}

// ---------------------------------------------------------------- review.rs

function daysLate(s: ReviewState) {
  return s.elapsedDays - s.scheduledDays
}

function passingNonearlyReviewIntervals(s: ReviewState, ctx: StateContext): [number, number, number] {
  const currentInterval = s.scheduledDays
  const late = Math.max(daysLate(s), 0)

  // hard
  const hardFactor = ctx.hardMultiplier
  const hardMinimum = hardFactor <= 1.0 ? 0 : s.scheduledDays + 1
  const hardInterval = constrainPassingInterval(ctx, currentInterval * hardFactor, hardMinimum, true)
  // good
  const goodMinimum = hardFactor <= 1.0 ? s.scheduledDays + 1 : hardInterval + 1
  const goodInterval = constrainPassingInterval(ctx, (currentInterval + late / 2.0) * s.easeFactor, goodMinimum, true)
  // easy
  const easyInterval = constrainPassingInterval(
    ctx,
    (currentInterval + late) * s.easeFactor * ctx.easyMultiplier,
    goodInterval + 1,
    true,
  )
  return [hardInterval, goodInterval, easyInterval]
}

/** Mostly a direct port of the Python version (used when a card is reviewed ahead of time). */
function passingEarlyReviewIntervals(s: ReviewState, ctx: StateContext): [number, number, number] {
  const scheduled = s.scheduledDays
  const elapsed = s.scheduledDays + daysLate(s)

  const hardInterval = (() => {
    const factor = ctx.hardMultiplier
    const halfUsual = factor / 2.0
    return constrainPassingInterval(ctx, Math.max(elapsed * factor, scheduled * halfUsual), 0, false)
  })()

  const goodInterval = constrainPassingInterval(ctx, Math.max(elapsed * s.easeFactor, scheduled), 0, false)

  const easyInterval = (() => {
    const easyBonus = ctx.easyMultiplier
    const reducedBonus = easyBonus - (easyBonus - 1.0) / 2.0
    return constrainPassingInterval(ctx, Math.max(elapsed * s.easeFactor, scheduled) * reducedBonus, 0, false)
  })()

  return [hardInterval, goodInterval, easyInterval]
}

function failingReviewInterval(s: ReviewState, ctx: StateContext): number {
  const [minimum, maximum] = minAndMaxReviewIntervals(ctx, ctx.minimumLapseInterval)
  const interval = s.scheduledDays * ctx.lapseMultiplier
  return Math.min(Math.max(Math.round(interval), minimum), maximum)
}

export function reviewNextStates(s: ReviewState, ctx: StateContext): SchedulingStates {
  const [hardI, goodI, easyI] =
    daysLate(s) < 0 ? passingEarlyReviewIntervals(s, ctx) : passingNonearlyReviewIntervals(s, ctx)

  const again = ((): CardState => {
    const lapses = s.lapses + 1
    const leeched = leechThresholdMet(lapses, ctx.leechThreshold)
    const againReview: ReviewState = {
      kind: 'review',
      scheduledDays: failingReviewInterval(s, ctx),
      elapsedDays: 0,
      easeFactor: Math.max(s.easeFactor + EASE_FACTOR_AGAIN_DELTA, MINIMUM_EASE_FACTOR),
      lapses,
      leeched,
    }
    const relearn = new LearningSteps(ctx.relearnSteps)
    const delay = relearn.againDelaySecsRelearn()
    if (delay != null) {
      return {
        kind: 'relearn',
        learning: { kind: 'learn', remainingSteps: relearn.remainingForFailed(), scheduledSecs: delay },
        review: againReview,
      }
    }
    return againReview
  })()

  const hard: ReviewState = {
    ...s,
    scheduledDays: hardI,
    elapsedDays: 0,
    easeFactor: Math.max(s.easeFactor + EASE_FACTOR_HARD_DELTA, MINIMUM_EASE_FACTOR),
    leeched: false,
  }
  const good: ReviewState = { ...s, scheduledDays: goodI, elapsedDays: 0, leeched: false }
  const easy: ReviewState = {
    ...s,
    scheduledDays: easyI,
    elapsedDays: 0,
    easeFactor: s.easeFactor + EASE_FACTOR_EASY_DELTA,
    leeched: false,
  }

  return { current: s, again, hard, good, easy }
}

// ---------------------------------------------------------------- relearning.rs

export function relearnNextStates(s: RelearnState, ctx: StateContext): SchedulingStates {
  const steps = new LearningSteps(ctx.relearnSteps)
  const review: ReviewState = { ...s.review, elapsedDays: 0, leeched: false }

  const again = ((): CardState => {
    const delay = steps.againDelaySecsRelearn()
    if (delay == null) return review
    return {
      kind: 'relearn',
      learning: { kind: 'learn', remainingSteps: steps.remainingForFailed(), scheduledSecs: delay },
      review,
    }
  })()

  const hard = ((): CardState => {
    const delay = steps.hardDelaySecs(s.learning.remainingSteps)
    if (delay == null) return review
    return { kind: 'relearn', learning: { ...s.learning, scheduledSecs: delay }, review }
  })()

  const good = ((): CardState => {
    const delay = steps.goodDelaySecs(s.learning.remainingSteps)
    if (delay == null) return review
    return {
      kind: 'relearn',
      learning: {
        kind: 'learn',
        scheduledSecs: delay,
        remainingSteps: steps.remainingForGood(s.learning.remainingSteps),
      },
      review,
    }
  })()

  const easy: ReviewState = { ...review, scheduledDays: s.review.scheduledDays + 1 }

  return { current: s, again, hard, good, easy }
}

// ---------------------------------------------------------------- dispatch

export function nextStates(state: CardState, ctx: StateContext): SchedulingStates {
  switch (state.kind) {
    case 'new': return newNextStates(ctx)
    case 'learn': return learningNextStates(state, ctx)
    case 'review': return reviewNextStates(state, ctx)
    case 'relearn': return relearnNextStates(state, ctx)
  }
}

export type IntervalKind = { secs: number } | { days: number }

export function intervalKind(state: CardState): IntervalKind {
  switch (state.kind) {
    case 'new': return { days: 0 }
    case 'learn': return { secs: state.scheduledSecs }
    case 'review': return { days: state.scheduledDays }
    case 'relearn': return { secs: state.learning.scheduledSecs }
  }
}

/** Anki: a learning delay that crosses the next day rollover is converted to days. */
export function maybeAsDays(kind: IntervalKind, secsUntilRollover: number): IntervalKind {
  if ('secs' in kind && kind.secs >= secsUntilRollover) {
    return { days: Math.floor((kind.secs - secsUntilRollover) / DAY) + 1 }
  }
  return kind
}

export function revlogInterval(kind: IntervalKind): number {
  return 'days' in kind ? kind.days : -kind.secs
}
