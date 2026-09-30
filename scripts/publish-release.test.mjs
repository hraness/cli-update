import assert from 'node:assert/strict';
import test from 'node:test';
import { planPublication, selectRelease } from './publish-release.mjs';
import { renderNotes } from './release-notes.mjs';

const source = 'a'.repeat(40);
const wanted = {
  tag: 'v1.2.3', source, title: 'CLI Update v1.2.3',
  notes: renderNotes({ changelog: '## 1.2.3\n\nA release.\n\n- One change.\n', version: '1.2.3', source, sha256: 'b'.repeat(64), bytes: 256 }),
  assets: [{ name: 'hraness-cli-update-1.2.3.tgz', digest: 'sha256:' + 'b'.repeat(64), size: 256 }, { name: 'SHA256SUMS', digest: 'sha256:' + 'c'.repeat(64), size: 99 }],
};
const draft = { tag_name: wanted.tag, target_commitish: source, name: wanted.title, body: wanted.notes, prerelease: false, draft: true, immutable: false, assets: [] };

test('release inventory finds drafts and rejects ambiguous tags', () => {
  assert.equal(selectRelease([], wanted.tag), undefined);
  assert.equal(selectRelease([{ ...draft, tag_name: 'v0.9.0' }, draft], wanted.tag), draft);
  assert.throws(() => selectRelease([draft, { ...draft, id: 2 }], wanted.tag));
});

test('fresh publication and partial draft retries never request an overwrite', () => {
  assert.deepEqual(planPublication(undefined, wanted), { create: true, upload: wanted.assets.map(asset => asset.name), publish: true });
  assert.deepEqual(planPublication({ ...draft, assets: [wanted.assets[0]] }, wanted), { create: false, upload: ['SHA256SUMS'], publish: true });
});

test('a complete immutable release is an idempotent verified no-op', () => {
  assert.deepEqual(planPublication({ ...draft, draft: false, immutable: true, assets: wanted.assets }, wanted), { create: false, upload: [], publish: false });
});

test('foreign, edited, or incomplete releases cannot be repaired by overwriting', () => {
  for (const release of [
    { ...draft, target_commitish: 'd'.repeat(40) },
    { ...draft, body: wanted.notes + '\nchanged' },
    { ...draft, assets: [{ ...wanted.assets[0], digest: 'sha256:' + 'd'.repeat(64) }] },
    { ...draft, assets: [{ name: 'unexpected', digest: 'sha256:' + 'c'.repeat(64), size: 1 }] },
    { ...draft, draft: false, immutable: true, assets: [wanted.assets[0]] },
    { ...draft, draft: false, immutable: false, assets: wanted.assets },
  ]) assert.throws(() => planPublication(release, wanted));
});
