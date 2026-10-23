const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('corresponding source snapshot matches deployed code and excludes private runtime state', () => {
  const bundle = require('../api/source-bundle.json');
  assert.equal(bundle.license, 'AGPL-3.0');
  for (const [file, contents] of Object.entries(bundle.files)) {
    assert(!file.includes('..') && !file.startsWith('.') && !file.includes('node_modules'));
    assert.equal(contents, fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), 'outdated source file ' + file);
  }
  for (const file of ['lib/qrc-decrypt.js', 'lib/lyric-providers.js', 'api/source.js', 'package-lock.json', 'LICENSE', 'NOTICE.md']) assert(bundle.files[file]);
  assert(bundle.files.LICENSE.includes('GNU AFFERO GENERAL PUBLIC LICENSE'));
});
