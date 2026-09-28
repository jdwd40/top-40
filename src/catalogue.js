'use strict';

// The markdown table is the single source of truth for catalogue songs.

const fs = require('fs');
const path = require('path');

const CATALOGUE_FILE = path.join(__dirname, '..', 'ridiculous-top-40-song-catalogue.md');
const GENRES = ['Hip-Hop', 'Dance/EDM', 'Rock', 'Pop', 'R&B', 'Country', 'Indie', 'Soul', 'Alternative', 'Electronic'];
const LEGACY_GENRES = {
  'R&B group': 'R&B',
  'Country group': 'Country',
  'Boy band': 'Pop',
  'Soft rock act': 'Rock',
  'Dance-pop diva': 'Dance/EDM',
  'Goth pop group': 'Alternative',
  'Comedy rap act': 'Hip-Hop',
  'Rap trio': 'Hip-Hop',
  'Dance duo': 'Dance/EDM',
  'Dance producer': 'Dance/EDM',
  'Electronic group': 'Electronic',
  'Female indie rock band': 'Indie',
  'Male indie band': 'Indie',
  'Female pop singer': 'Pop',
  'Male pop singer': 'Pop',
  'Female soul singer': 'Soul',
  'Male country band': 'Country',
  'Female dance-pop singer': 'Dance/EDM',
  'Male pop group': 'Pop',
};

function bandIdFor(artist) {
  return artist.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function parseCatalogue(markdown) {
  const songs = [];
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('| SONG-')) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 4) continue;
    const [song_id, artist, rawGenre, title] = cells;
    if (!/^SONG-\d{3}$/.test(song_id)) continue;
    const bandId = cells[4] || bandIdFor(artist);
    const superBand = ['1', 'true', 'super'].includes((cells[5] || '').toLowerCase());
    const legacy = cells[6] === undefined ? true : !['0', 'false', 'current'].includes(cells[6].toLowerCase());
    const genre = LEGACY_GENRES[rawGenre] || rawGenre;
    if (!GENRES.includes(genre)) continue;
    songs.push({ song_id, artist, genre, title, bandId, superBand, legacy });
  }
  return songs;
}

let cache = null;
function getCatalogue() {
  if (!cache) cache = parseCatalogue(fs.readFileSync(CATALOGUE_FILE, 'utf8'));
  return cache;
}

module.exports = { parseCatalogue, getCatalogue, CATALOGUE_FILE, GENRES, bandIdFor };
