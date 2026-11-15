/** Compares dotted versions such as "2.11.0" or "v2.10.22-RC.1". Pre-release tags are ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  return 0
}

export function versionAtLeast(version: string | undefined, minimum: string): boolean {
  if (!version) return false
  return compareVersions(version, minimum) >= 0
}

function parse(v: string): [number, number, number] {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(v)
  if (!m) return [0, 0, 0]
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)]
}
