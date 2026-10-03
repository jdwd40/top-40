'use strict';
// Explicit offline reset of one configured game, never imported by server startup.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store, freshState } = require('../src/state');
const { catchUp } = require('../src/chart');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function main() {
  const [file, backup, expectedHash, acknowledgement] = process.argv.slice(2);
  if (process.argv.length !== 6 || !file || !backup || !path.isAbsolute(file) || !path.isAbsolute(backup) ||
      !/^[a-f0-9]{64}$/.test(expectedHash || '') || acknowledgement !== '--service-stopped') {
    throw new Error('Usage: node scripts/reset-hourly.js /absolute/state.json /absolute/private/backup.json ORIGINAL_SHA256 --service-stopped');
  }
  const source = await fs.promises.realpath(file);
  const publicDir = path.resolve(__dirname, '../public');
  await fs.promises.mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
  const backupDir = await fs.promises.realpath(path.dirname(backup));
  const backupFile = path.join(backupDir, path.basename(backup));
  if (!(await fs.promises.lstat(file)).isFile() || source === backupFile ||
      backupFile === publicDir || backupFile.startsWith(publicDir + path.sep)) {
    throw new Error('State must be a regular file; backup must be separate and outside public serving paths');
  }
  const bytes = await fs.promises.readFile(source);
  const previous = JSON.parse(bytes); // missing, empty or corrupt data: fail before backup/reset
  if (![1, 2].includes(previous?.version) || !previous.counters ||
      !['releases', 'snapshots', 'submissions', 'activeSongIds', 'corrections'].every(key => Array.isArray(previous[key]))) {
    throw new Error('Refusing to reset unsupported or malformed game state');
  }
  if (previous.version === 2) await new Store(source).init();
  if (hash(bytes) !== expectedHash) {
    if (previous.hourlyReset?.sourceSha256 === expectedHash && previous.hourlyReset.backupFile === backupFile &&
        hash(await fs.promises.readFile(backupFile)) === expectedHash) {
      console.log(JSON.stringify({ created: false, hour: previous.originHour, sourceSha256: expectedHash, backupFile }));
      return;
    }
    throw new Error('State hash changed; stop the writer and review the exact target before retrying');
  }
  // Exclusive, private, synced backup. Never clobber a previous recovery copy.
  const fh = await fs.promises.open(backupFile, 'wx', 0o600);
  try { await fh.writeFile(bytes); await fh.sync(); }
  finally { await fh.close(); }
  if (hash(await fs.promises.readFile(backupFile)) !== expectedHash) throw new Error('Backup verification failed; state untouched');
  if (hash(await fs.promises.readFile(source)) !== expectedHash) throw new Error('Concurrent writer changed state; backup kept, reset refused');
  const now = new Date();
  const store = new Store(source);
  store.state = freshState(now);
  store.state.hourlyReset = { at: now.toISOString(), sourceSha256: expectedHash, backupFile };
  await store.update(state => catchUp(state, now));
  const verified = new Store(source); await verified.init();
  if (verified.state.version !== 2 || verified.state.originHour !== store.state.originHour || verified.state.releases.length !== 4) {
    throw new Error('Reset readback failed; keep the writer stopped and restore the backup');
  }
  console.log(JSON.stringify({ created: true, hour: verified.state.originHour, entries: 4, sourceSha256: expectedHash, backupFile }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
