import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const rust = await readFile(new URL('../rust/Cargo.toml', import.meta.url), 'utf8');
const version = /^version\s*=\s*"([^"]+)"/mu.exec(rust)?.[1];
assert.equal(version, manifest.version, 'TypeScript and Rust release versions must match');
assert.match(manifest.version, /^\d+\.\d+\.\d+$/u);
if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert.equal(process.env.GITHUB_REF_NAME, `v${manifest.version}`, 'Tag must match package versions');
}
console.log(`Release identity v${manifest.version} matches both implementations.`);
