// Port of Anki's rslib/src/scheduler/answering/{mod,learning,review,relearning}.rs:
// turning a card into a CardState, and applying the chosen next state back onto the card.

import type { Card, DeckConfig, Revlog } from '../model'
import { fuzzFactorFor, withLearningFuzz } from './fuzz'
import {
  type CardState,
  type IntervalKind,
  type SchedulingStates,
  type StateContext,
  intervalKind,
  maybeAsDays,
  nextStates,
  revlogInterval,
} from './states'
import type { Timing } from './timing'

export type Rating = 1 | 2 | 3 | 4

export function stateContext(cfg: DeckConfig, card: Card, fuzz = true): StateContext {
  return {
    steps: cfg.learnSteps,
    relearnSteps: cfg.relearnSteps,
    graduatingIntervalGood: cfg.graduatingIvl,
    graduatingIntervalEasy: cfg.easyIvl,
    initialEaseFactor: cfg.initialEase,
    hardMultiplier: cfg.hardFactor,
    easyMultiplier: cfg.easyBonus,
    intervalMultiplier: cfg.ivlModifier,
    maximumReviewInterval: cfg.maxIvl,
    lapseMultiplier: cfg.lapseMult,
    minimumLapseInterval: cfg.minLapseIvl,
    leechThreshold: cfg.leechThreshold,
    fuzzFactor: fuzz ? fuzzFactorFor(card.id, card.reps) : null,
  }
}

/** Anki: elapsed days since the last review, derived from due - interval. */
function daysSinceLastReview(card: Card, t: Timing): number {
  if (card.queue === 2 || card.queue === 3) return Math.max(0, t.today - (card.due - card.ivl))
  return 0
}

export function cardState(card: Card, t: Timing): CardState {
  const ease = card.factor / 1000
  switch (card.type) {
    case 0:
      return { kind: 'new' }
    case 1:
      return { kind: 'learn', remainingSteps: card.left, scheduledSecs: card.stepSecs }
    case 2:
      return {
        kind: 'review',
        scheduledDays: card.ivl,
        elapsedDays: daysSinceLastReview(card, t),
        easeFactor: ease,
        lapses: card.lapses,
        leeched: false,
      }
    case 3:
      return {
        kind: 'relearn',
        learning: { kind: 'learn', remainingSteps: card.left, scheduledSecs: card.stepSecs },
        review: {
          kind: 'review',
          scheduledDays: card.ivl,
          elapsedDays: 0,
          easeFactor: ease,
          lapses: card.lapses,
          leeched: false,
        },
      }
  }
}

export function previewStates(card: Card, cfg: DeckConfig, t: Timing): SchedulingStates {
  return nextStates(cardState(card, t), stateContext(cfg, card))
}

export function stateFor(states: SchedulingStates, rating: Rating): CardState {
  return [states.again, states.hard, states.good, states.easy][rating - 1]
}

/** The interval to show on an answer button, as Anki computes it. */
export function buttonInterval(state: CardState, t: Timing): IntervalKind {
  return maybeAsDays(intervalKind(state), t.secsUntilRollover)
}

function revlogKind(current: CardState): 0 | 1 | 2 {
  switch (current.kind) {
    case 'new':
    case 'learn':
      return 0
    case 'review':
      return 1
    case 'relearn':
      return 2
  }
}

function setLearningDue(card: Card, secs: number, t: Timing, rand?: () => number) {
  const k = maybeAsDays({ secs }, t.secsUntilRollover)
  if ('secs' in k) {
    card.queue = 1
    card.due = t.now + withLearningFuzz(secs, rand)
  } else {
    card.queue = 3
    card.due = t.today + k.days
  }
}

export interface AnswerResult {
  card: Card
  revlog: Omit<Revlog, 'hlc' | 'seq' | 'id'>
  leeched: boolean
}

export function answerCard(
  input: Card,
  cfg: DeckConfig,
  rating: Rating,
  t: Timing,
  takenMs: number,
  opts: { fuzz?: boolean; rand?: () => number } = {},
): AnswerResult {
  const card: Card = { ...input }
  const current = cardState(card, t)
  const states = nextStates(current, stateContext(cfg, card, opts.fuzz ?? true))
  const next = stateFor(states, rating)
  const from: Revlog['from'] = card.queue === 0 ? 'new' : card.queue === 1 ? 'learn' : 'review'

  let leeched = false
  switch (next.kind) {
    case 'learn':
      card.type = 1
      card.left = next.remainingSteps
      card.stepSecs = next.scheduledSecs
      setLearningDue(card, next.scheduledSecs, t, opts.rand)
      break
    case 'review':
      card.type = 2
      card.queue = 2
      card.ivl = next.scheduledDays
      card.due = t.today + next.scheduledDays
      card.factor = Math.round(next.easeFactor * 1000)
      card.lapses = next.lapses
      card.left = 0
      card.stepSecs = 0
      leeched = next.leeched
      break
    case 'relearn':
      card.type = 3
      card.ivl = next.review.scheduledDays
      card.factor = Math.round(next.review.easeFactor * 1000)
      card.lapses = next.review.lapses
      card.left = next.learning.remainingSteps
      card.stepSecs = next.learning.scheduledSecs
      setLearningDue(card, next.learning.scheduledSecs, t, opts.rand)
      leeched = next.review.leeched
      break
    case 'new':
      break
  }
  card.reps += 1
  if (leeched && cfg.leechAction === 'suspend') card.suspended = true

  const nextEase = next.kind === 'review' ? next.easeFactor : next.kind === 'relearn' ? next.review.easeFactor : 0
  return {
    card,
    leeched,
    revlog: {
      cardId: card.id,
      deckId: card.deckId,
      time: t.now * 1000,
      rating,
      ivl: revlogInterval(intervalKind(next)),
      lastIvl: revlogInterval(intervalKind(current)),
      factor: Math.round(nextEase * 1000),
      taken: Math.min(takenMs, 60_000),
      kind: revlogKind(current),
      from,
    },
  }
}

/** Anki-style compact time span for answer buttons: "<10m", "1d", "3.2mo". */
export function formatInterval(k: IntervalKind, learning: boolean): string {
  const secs = 'secs' in k ? k.secs : k.days * 86_400
  const units: [string, number][] = [
    ['s', 1],
    ['m', 60],
    ['h', 3600],
    ['d', 86_400],
    ['mo', 86_400 * 30],
    ['y', 86_400 * 365],
  ]
  let unit = units[0]
  if (secs >= 86_400 * 365) unit = units[5]
  else if (secs >= 86_400 * 30) unit = units[4]
  else if (secs >= 86_400) unit = units[3]
  else if (secs >= 3600) unit = units[2]
  else if (secs >= 60) unit = units[1]
  const v = secs / unit[1]
  const precise = unit[0] === 'h' || unit[0] === 'mo' || unit[0] === 'y'
  const n = precise ? Math.round(v * 10) / 10 : Math.round(v)
  const txt = `${n}${unit[0]}`
  return learning && 'secs' in k ? `<${txt}` : txt
}
