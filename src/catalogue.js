'use strict';

// Parses ridiculous-top-40-song-catalogue.md. The markdown table is the single
// source of truth for the 100 stable catalogue songs; nothing here is
// hand-duplicated.

const fs = require('fs');
const path = require('path');

const CATALOGUE_FILE = path.join(__dirname, '..', 'ridiculous-top-40-song-catalogue.md');

function parseCatalogue(markdown) {
  const songs = [];
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('| SONG-')) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 4) continue;
    const [song_id, artist, genre, title] = cells;
    if (!/^SONG-\d{3}$/.test(song_id)) continue;
    songs.push({ song_id, artist, genre, title });
  }
  return songs;
}

let cache = null;
function getCatalogue() {
  if (!cache) cache = parseCatalogue(fs.readFileSync(CATALOGUE_FILE, 'utf8'));
  return cache;
}

module.exports = { parseCatalogue, getCatalogue, CATALOGUE_FILE };
