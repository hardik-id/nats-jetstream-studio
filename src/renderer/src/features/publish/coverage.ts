import { subjectMatches } from '@shared/subject'
import type { StreamPatterns } from '../subjects/subjectTree'

/** The stream that stores a subject, and the pattern of that stream which matches it. */
export interface Capture {
  stream: string
  pattern: string
}

/**
 * The first stream with a pattern that matches a concrete subject: the stream that stores a message
 * published to it. Null when no stream does. A mirror has no patterns, so it never matches.
 */
export function capturedBy(subject: string, streams: readonly StreamPatterns[]): Capture | null {
  for (const s of streams) {
    const pattern = s.subjects.find((p) => subjectMatches(p, subject))
    if (pattern !== undefined) return { stream: s.name, pattern }
  }
  return null
}

/** The hint under the Subject field: which stream stores the subject, or that none does. */
export function coverageHint(capture: Capture | null, jetstream: boolean): string {
  if (capture) return `Stored by ${capture.stream} (${capture.pattern}).`
  return jetstream
    ? 'No stream stores this subject, so a JetStream publish will fail.'
    : 'No stream stores this subject. Only live subscribers see it.'
}

/**
 * What a core publish says about storage after it was sent. No confirmation comes back, so this
 * reports what the stream setup implies.
 */
export function coverageSentence(capture: Capture | null): string {
  return capture
    ? `${capture.stream} captures this subject (${capture.pattern}), so it should be stored.`
    : 'No stream captures this subject, so only live subscribers can receive it.'
}
