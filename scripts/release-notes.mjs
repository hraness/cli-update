import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = 'hraness/cli-update';

export function renderNotes({ changelog, version, source, sha256, bytes }) {
  assert.match(version, /^\d+\.\d+\.\d+$/u);
  assert.match(source, /^[a-f0-9]{40}$/u);
  assert.match(sha256, /^[a-f0-9]{64}$/u);
  assert(Number.isSafeInteger(bytes) && bytes > 0);
  const sections = [...changelog.matchAll(/^## (v?\d+\.\d+\.\d+)(?: - \d{4}-\d{2}-\d{2})?[^\S\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/gmu)];
  const matches = sections.filter(match => match[1].replace(/^v/u, '') === version);
  assert.equal(matches.length, 1, 'The release needs exactly one matching changelog section.');
  const section = matches[0][2].trim();
  const bullet = section.search(/^- /mu);
  assert(bullet > 0, 'The changelog section needs a summary and a Changes list.');
  const summary = section.slice(0, bullet).trim();
  const changes = section.slice(bullet).trim();
  assert(summary && !/unreleased|to be written|TODO/iu.test(section), 'Release notes must be complete.');
  assert(!/^#/mu.test(section), 'The version section must contain a summary and bullets.');
  const tag = 'v' + version;
  const archive = 'hraness-cli-update-' + version + '.tgz';
  const url = 'https://github.com/' + repository;
  const identity = {
    schema: 'hraness.cli-update.release.v1',
    repository,
    tag,
    version,
    source,
    assets: [{ name: archive, sha256, bytes }],
  };
  return [
    summary,
    '## Changes',
    changes,
    '## Install',
    'Add the JavaScript library to a CLI project:',
    '```sh\nbun add ' + url + '/releases/download/' + tag + '/' + archive + '\n```',
    'Add the native library to a Rust CLI:',
    '```toml\n[dependencies]\nhraness-cli-update = { git = "' + url + '.git", tag = "' + tag + '" }\n```',
    '## Verify',
    'Download [`SHA256SUMS`](' + url + '/releases/download/' + tag + '/SHA256SUMS) and follow the [verification guide](' + url + '/blob/' + tag + '/VERIFY.md) to check the archive and build attestation.',
    'Source commit: [`' + source + '`](' + url + '/commit/' + source + ').',
    '<!-- hraness-cli-update-release ' + JSON.stringify(identity) + ' -->',
  ].join('\n\n');
}

export function verifyNotes(actual, expected) {
  // gh --jq adds one newline when writing the stored body to a local file.
  const body = actual.endsWith('\n') ? actual.slice(0, -1) : actual;
  assert.equal(body, expected, 'Published release notes differ from the reviewed source or release assets.');
  const marker = '<!-- hraness-cli-update-release ';
  const index = body.lastIndexOf(marker);
  assert(index >= 0 && body.endsWith(' -->'), 'Release identity must be the final bytes.');
  const record = JSON.parse(body.slice(index + marker.length, -4));
  assert.equal(record.schema, 'hraness.cli-update.release.v1');
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, '..');
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const archive = resolve(root, 'release', 'hraness-cli-update-' + manifest.version + '.tgz');
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const notes = renderNotes({
    changelog: await readFile(resolve(root, 'CHANGELOG.md'), 'utf8'),
    version: manifest.version,
    source,
    sha256: createHash('sha256').update(await readFile(archive)).digest('hex'),
    bytes: (await stat(archive)).size,
  });
  if (process.argv[2] === '--write' && process.argv.length === 4) {
    await writeFile(process.argv[3], notes);
  } else if (process.argv[2] === '--verify' && process.argv.length === 4) {
    verifyNotes(await readFile(process.argv[3], 'utf8'), notes);
    console.log('Published release notes and identity match the reviewed source and archive.');
  } else {
    throw new Error('Usage: release-notes.mjs --write FILE | --verify FILE');
  }
}
