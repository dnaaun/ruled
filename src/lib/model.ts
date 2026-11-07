export type Table = 'decks' | 'notes' | 'cards' | 'revlog'
export const TABLES: Table[] = ['decks', 'notes', 'cards', 'revlog']

/** Every synced record carries a hybrid-logical-clock stamp (for last-writer-wins) and a local sequence number. */
export interface Base {
  id: string
  hlc: string
  seq: number
  del?: 1
}

export interface DeckConfig {
  newPerDay: number
  reviewsPerDay: number
  learnSteps: number[]
  relearnSteps: number[]
  graduatingIvl: number
  easyIvl: number
  initialEase: number
  easyBonus: number
  hardFactor: number
  ivlModifier: number
  lapseMult: number
  minLapseIvl: number
  maxIvl: number
  leechThreshold: number
  leechAction: 'tag' | 'suspend'
  newMix: 'mix' | 'after' | 'before'
}

/** Anki's default deck options preset. */
export const DEFAULT_CONFIG: DeckConfig = {
  newPerDay: 20,
  reviewsPerDay: 200,
  learnSteps: [1, 10],
  relearnSteps: [10],
  graduatingIvl: 1,
  easyIvl: 4,
  initialEase: 2.5,
  easyBonus: 1.3,
  hardFactor: 1.2,
  ivlModifier: 1.0,
  lapseMult: 0.0,
  minLapseIvl: 1,
  maxIvl: 36500,
  leechThreshold: 8,
  leechAction: 'tag',
  newMix: 'mix',
}

export interface Deck extends Base {
  name: string
  created: number
  config: DeckConfig
  color?: number
}

export type NoteKind = 'basic' | 'reversed' | 'cloze'

export interface Note extends Base {
  deckId: string
  kind: NoteKind
  /** basic/reversed: front, back. cloze: text, extra */
  fields: Record<string, string>
  tags: string[]
  created: number
  mod: number
}

/** type: 0 new, 1 learning, 2 review, 3 relearning (same as Anki's card.type) */
export type CardType = 0 | 1 | 2 | 3
/** queue: 0 new, 1 intraday learning (due = epoch secs), 2 review (due = day), 3 interday learning (due = day) */
export type CardQueue = 0 | 1 | 2 | 3

export interface Card extends Base {
  noteId: string
  deckId: string
  ord: number
  type: CardType
  queue: CardQueue
  /** new: position (creation ms); learn: epoch secs; review / day-learn: day number */
  due: number
  /** days */
  ivl: number
  /** permille, like Anki (2500 = 2.5) */
  factor: number
  reps: number
  lapses: number
  /** remaining learning steps */
  left: number
  /** last scheduled learning delay in seconds (for revlog lastIvl) */
  stepSecs: number
  suspended?: boolean
  buriedUntil?: number
  created: number
}

/** revlog kind: 0 learn, 1 review, 2 relearn (same as Anki) */
export interface Revlog extends Base {
  cardId: string
  deckId: string
  /** epoch ms */
  time: number
  /** 1 again, 2 hard, 3 good, 4 easy */
  rating: 1 | 2 | 3 | 4
  /** positive days, negative seconds */
  ivl: number
  lastIvl: number
  factor: number
  /** ms spent answering */
  taken: number
  kind: 0 | 1 | 2
  /** queue the card was answered from (for daily limits) */
  from: 'new' | 'learn' | 'review'
}

export type Rec = Deck | Note | Card | Revlog
