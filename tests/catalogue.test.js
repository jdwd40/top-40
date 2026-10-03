'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { parseCatalogue, getCatalogue, CATALOGUE_FILE, GENRES } = require('../src/catalogue');

test('parses the preserved legacy songs plus the expanded catalogue', () => {
  const songs = parseCatalogue(fs.readFileSync(CATALOGUE_FILE, 'utf8'));
  assert.ok(songs.length >= 2400);
  assert.equal(songs[0].song_id, 'SONG-001');
  assert.equal(songs[0].artist, 'Velvet Avenue');
  assert.equal(songs[99].song_id, 'SONG-100');
  assert.equal(songs[99].artist, 'The Monday Boys');
  assert.equal(songs[100].song_id, 'SONG-101');
  for (const s of songs) {
    assert.match(s.song_id, /^SONG-\d{3,}$/);
    assert.ok(s.artist.length > 0);
    assert.ok(s.genre.length > 0);
    assert.ok(s.title.length > 0);
  }
  assert.equal(new Set(songs.map(s => s.song_id)).size, songs.length, 'song ids unique');
});

test('getCatalogue caches the parsed catalogue', () => {
  const a = getCatalogue();
  const b = getCatalogue();
  assert.equal(a, b);
  assert.ok(a.length >= 2400);
});

test('keeps legacy songs and parses expanded realistic catalogue metadata', () => {
  const songs = parseCatalogue(fs.readFileSync(CATALOGUE_FILE, 'utf8'));
  assert.ok(songs.length >= 2400);
  assert.equal(songs.filter((song) => song.legacy).length, 100);
  assert.ok(songs.some((song) => song.bandId && song.superBand === true));
  assert.ok(songs.some((song) => song.artist === 'Harbor Lights' && song.genre === 'Rock'));
  assert.equal(new Set(songs.map((song) => song.song_id)).size, songs.length);
  for (const song of songs) assert.ok(GENRES.includes(song.genre));
});

test('large catalogue has at least 300 current bands and preserves four-digit IDs', () => {
  const songs = getCatalogue();
  assert.ok(new Set(songs.filter(s => !s.legacy).map(s => s.bandId)).size >= 300);
  const [large] = parseCatalogue('| SONG-2401 | Copper Echo | Rock | Northern Lights | copper-echo | 0 | current |');
  assert.equal(large.song_id, 'SONG-2401');
  assert.equal(large.legacy, false);
});

test('legacy four-column rows default to preserved legacy metadata', () => {
  const [song] = parseCatalogue('| SONG-001 | Old Act | Pop | Old Song |\n');
  assert.equal(song.bandId, 'old-act');
  assert.equal(song.superBand, false);
  assert.equal(song.legacy, true);
});
