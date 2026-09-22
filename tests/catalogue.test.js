'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { parseCatalogue, getCatalogue, CATALOGUE_FILE } = require('../src/catalogue');

test('parses exactly 100 songs from the catalogue markdown', () => {
  const songs = parseCatalogue(fs.readFileSync(CATALOGUE_FILE, 'utf8'));
  assert.equal(songs.length, 100);
  assert.equal(songs[0].song_id, 'SONG-001');
  assert.equal(songs[0].artist, 'Velvet Avenue');
  assert.equal(songs[99].song_id, 'SONG-100');
  assert.equal(songs[99].artist, 'The Monday Boys');
  for (const s of songs) {
    assert.match(s.song_id, /^SONG-\d{3}$/);
    assert.ok(s.artist.length > 0);
    assert.ok(s.genre.length > 0);
    assert.ok(s.title.length > 0);
  }
  assert.equal(new Set(songs.map(s => s.song_id)).size, 100, 'song ids unique');
});

test('getCatalogue caches the parsed catalogue', () => {
  const a = getCatalogue();
  const b = getCatalogue();
  assert.equal(a, b);
  assert.equal(a.length, 100);
});
