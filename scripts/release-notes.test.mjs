import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { renderNotes, verifyNotes } from './release-notes.mjs';

const fixture = {
  version: '1.2.3',
  source: 'a'.repeat(40),
  sha256: 'b'.repeat(64),
  bytes: 256,
  changelog: '# Changelog\n\n## Unreleased\n\nFuture work.\n\n## v1.2.3 - 2026-09-30\n\nUpdates keep the selected installation channel.\n\n- Preserve the selected release channel.\n- Retain saved opt-outs.\n\n## 1.2.2\n\nOlder changes.\n\n- Earlier behavior.\n',
};

test('only reviewed version notes are rendered with exact installation and final identity', () => {
  const notes = renderNotes(fixture);
  assert(notes.startsWith('Updates keep the selected installation channel.\n\n## Changes\n\n- Preserve'));
  assert(!notes.includes('Future work') && !notes.includes('Older changes'));
  assert(notes.includes('/releases/download/v1.2.3/hraness-cli-update-1.2.3.tgz'));
  const identity = verifyNotes(notes + '\n', notes);
  assert.equal(identity.source, fixture.source);
  assert.equal(identity.assets[0].sha256, fixture.sha256);
  assert.throws(() => verifyNotes(notes.replace('Retain saved', 'Ignore saved'), notes));
  assert.throws(() => verifyNotes(notes + '\nhand edit', notes));
});

test('incomplete, absent, or duplicate changelog sections cannot ship', () => {
  for (const changelog of [
    '# Changelog\n\n## Unreleased\n\n- A change.\n',
    '## 1.2.3\n\n- No summary.\n',
    '## 1.2.3\n\nOnly a summary.\n',
    '## 1.2.3\n\nTODO\n\n- A change.\n',
    fixture.changelog + '\n## 1.2.3\n\nDuplicate.\n\n- Another.\n',
  ]) assert.throws(() => renderNotes({ ...fixture, changelog }));
});

test('the current release changelog has a summary and changes', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const notes = renderNotes({
    ...fixture,
    version: manifest.version,
    changelog: await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8'),
  });
  assert.equal(verifyNotes(notes, notes).version, manifest.version);
});
