/** Anki's "next day starts at" (hours past midnight, local time). */
export const ROLLOVER_HOUR = 4
/** Anki's "learn ahead limit" (minutes). */
export const LEARN_AHEAD_MINS = 20

export interface Timing {
  /** epoch seconds */
  now: number
  /** day number — days since the Unix epoch in local time, shifted by the rollover hour */
  today: number
  /** epoch seconds of the next rollover */
  nextDayAt: number
  secsUntilRollover: number
}

export function dayNumber(ms: number, rollover = ROLLOVER_HOUR): number {
  const local = new Date(ms - rollover * 3_600_000)
  return Math.round(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()) / 86_400_000)
}

export function timing(nowMs = Date.now(), rollover = ROLLOVER_HOUR): Timing {
  const local = new Date(nowMs - rollover * 3_600_000)
  const nextDay = new Date(local.getFullYear(), local.getMonth(), local.getDate() + 1, rollover, 0, 0, 0)
  const now = Math.floor(nowMs / 1000)
  const nextDayAt = Math.floor(nextDay.getTime() / 1000)
  return { now, today: dayNumber(nowMs, rollover), nextDayAt, secsUntilRollover: nextDayAt - now }
}

/** Epoch ms at which a given day number starts (local, after rollover). */
export function dayStartMs(day: number, rollover = ROLLOVER_HOUR): number {
  const d = new Date(day * 86_400_000)
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), rollover).getTime()
}
