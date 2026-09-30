interface Version { major: bigint; minor: bigint; patch: bigint; prerelease: string[] }

export function parseVersion(input: string): Version | undefined {
  if (input.length > 128) return undefined;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(input);
  if (!match) return undefined;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return undefined;
  return { major: BigInt(match[1]!), minor: BigInt(match[2]!), patch: BigInt(match[3]!), prerelease };
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) throw new Error('Invalid semantic version.');
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length ? -1 : b.prerelease.length ? 1 : 0;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i], y = b.prerelease[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
