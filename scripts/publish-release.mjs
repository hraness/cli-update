import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyNotes } from './release-notes.mjs';

const repository = 'hraness/cli-update';
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

export function selectRelease(releases, tag) {
  const matching = releases.filter(release => release.tag_name === tag);
  assert(matching.length <= 1, 'Multiple releases have the requested tag.');
  return matching[0];
}

/** A retry may fill an owned draft, but never replace existing release bytes. */
export function planPublication(existing, wanted) {
  if (!existing) return { create: true, upload: wanted.assets.map(asset => asset.name), publish: true };
  assert.equal(existing.tag_name, wanted.tag, 'Existing release tag differs.');
  assert.equal(existing.name, wanted.title, 'Existing release title differs.');
  assert.equal(existing.target_commitish, wanted.source, 'Existing release source differs.');
  verifyNotes(existing.body, wanted.notes);
  assert.equal(existing.prerelease, false, 'This library publishes stable releases.');
  assert(Array.isArray(existing.assets), 'Missing release asset inventory.');
  const names = new Set();
  for (const actual of existing.assets) {
    assert(!names.has(actual.name), 'Duplicate release asset.');
    names.add(actual.name);
    const expected = wanted.assets.find(asset => asset.name === actual.name);
    assert(expected, 'An unexpected asset is attached to the release.');
    assert.equal(actual.digest, expected.digest, 'Existing asset bytes differ.');
    assert.equal(actual.size, expected.size, 'Existing asset size differs.');
  }
  const upload = wanted.assets.filter(asset => !names.has(asset.name)).map(asset => asset.name);
  if (!existing.draft) {
    assert.equal(existing.immutable, true, 'Published release must be immutable.');
    assert.equal(upload.length, 0, 'Published release is incomplete.');
  }
  return { create: false, upload, publish: existing.draft };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, '..');
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/u);
  const tag = 'v' + manifest.version;
  assert.equal(process.env.GITHUB_REF_NAME, tag, 'Publication requires the matching version tag.');
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.match(source, /^[a-f0-9]{40}$/u);
  assert.equal(process.env.GITHUB_SHA, source, 'Publication must run at the tagged source commit.');
  const notesPath = resolve(root, 'release', 'notes.md');
  const notes = await readFile(notesPath, 'utf8');
  const assets = [];
  for (const name of ['hraness-cli-update-' + manifest.version + '.tgz', 'SHA256SUMS']) {
    const path = resolve(root, 'release', name);
    const bytes = await readFile(path);
    assets.push({ name, path, digest: digest(bytes), size: bytes.length });
  }
  const wanted = { tag, source, title: 'CLI Update ' + tag, notes, assets };
  const gh = args => execFileSync('gh', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  const readRelease = () => {
    // The published-tag endpoint may return 404 for an owned draft. Read the
    // complete bounded inventory so retries find drafts and reject duplicates.
    const releases = [];
    for (let page = 1; page <= 20; page++) {
      const batch = JSON.parse(gh(['api', 'repos/' + repository + '/releases?per_page=100&page=' + page]));
      assert(Array.isArray(batch) && batch.length <= 100, 'Invalid release inventory.');
      releases.push(...batch);
      if (batch.length < 100) return selectRelease(releases, tag);
    }
    throw new Error('Release inventory exceeds its bounded complete scan.');
  };
  // Repository administrators enable immutable releases at setup and verify
  // that setting in the owner release preflight. GITHUB_TOKEN has no repository
  // administration permission. The published release itself is verified below.
  let plan = planPublication(readRelease(), wanted);
  if (plan.create) {
    gh(['release', 'create', tag, '--repo', repository, '--verify-tag', '--draft', '--target', source, '--title', wanted.title, '--notes-file', notesPath]);
    plan = planPublication(readRelease(), wanted);
  }
  for (const name of plan.upload) {
    const asset = assets.find(candidate => candidate.name === name);
    gh(['release', 'upload', tag, asset.path, '--repo', repository]);
  }
  plan = planPublication(readRelease(), wanted);
  assert.equal(plan.upload.length, 0, 'The draft is incomplete.');
  if (plan.publish) gh(['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest']);
  const final = planPublication(readRelease(), wanted);
  assert.deepEqual(final, { create: false, upload: [], publish: false });
  console.log('Verified immutable release https://github.com/' + repository + '/releases/tag/' + tag);
}
