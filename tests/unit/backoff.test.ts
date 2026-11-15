import { describe, expect, it } from 'vitest'
import { ReconnectBackoff } from '@core/natsConnection'

/** Replays the client's dial loop: it asks for a delay each time it wakes and dials once that delay has passed. */
function simulateDials(backoff: ReconnectBackoff, untilMs: number): number[] {
  const dials: number[] = []
  let now = 1_000_000
  const start = now
  let lastConnect = now - 60_000
  while (now - start <= untilMs) {
    const wait = backoff.delay(now)
    if (lastConnect + wait <= now) {
      dials.push(now - start)
      lastConnect = now
    } else {
      now += Math.max(1, Math.min(wait, lastConnect + wait - now))
    }
  }
  return dials
}

describe('reconnect backoff', () => {
  it('retries quickly at first, then backs off to every 8 seconds', () => {
    const dials = simulateDials(new ReconnectBackoff(), 40_000)
    expect(dials[0]).toBe(0)
    expect(dials[1]).toBeLessThanOrEqual(300)
    // Several attempts in the first two seconds, so a quick server restart is picked up fast.
    expect(dials.filter((t) => t <= 2100).length).toBeGreaterThanOrEqual(4)
    const gaps = dials.slice(1).map((t, i) => t - dials[i])
    expect(Math.max(...gaps)).toBeLessThanOrEqual(8100)
    expect(gaps[gaps.length - 1]).toBeGreaterThanOrEqual(7900)
    // Gaps never shrink while the server stays down.
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1] - 5)
  })

  it('starts over after the connection comes back', () => {
    const backoff = new ReconnectBackoff()
    simulateDials(backoff, 30_000)
    backoff.reset()
    expect(simulateDials(backoff, 1000).length).toBeGreaterThanOrEqual(3)
  })
})
