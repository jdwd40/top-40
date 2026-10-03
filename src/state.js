'use strict';

// JSON-file persistence with atomic temp-file rename and an in-process async
// write lock. TOP40_DATA_FILE overrides the data file location (tests, deploy).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { currentChartDay } = require('./dates');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'state.json');

function dataFile() {
  return process.env.TOP40_DATA_FILE || DEFAULT_FILE;
}

function freshState() {
  return {
    version: 1,
    seed: crypto.randomInt(0, 2 ** 31),
    originDay: currentChartDay(),
    lastGeneratedDay: null,
    lastScheduledDay: null,
    releases: [],
    submissions: [],
    snapshots: [],
    activeSongIds: [],
    corrections: [],
    counters: { release: 0, submission: 0 },
  };
}

async function saveAtomic(file, state) {
  const tmp = `${file}.${process.pid}.tmp`;
  const json = JSON.stringify(state, null, 2);
  const fh = await fs.promises.open(tmp, 'w');
  try {
    await fh.writeFile(json);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.promises.rename(tmp, file);
}

class Store {
  constructor(file = dataFile()) {
    this.file = file;
    this.state = null;
    this.queue = Promise.resolve(); // in-process write lock
  }

  async init() {
    let raw = null;
    try {
      raw = await fs.promises.readFile(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (raw === null || raw.trim() === '') {
      this.state = freshState();
      await this._persist();
    } else {
      this.state = JSON.parse(raw); // throws on corrupt file: fail loudly, do not silently reset
      if (!this.state || this.state.version !== 1) throw new Error(`Unsupported state version in ${this.file}`);
    }
    return this.state;
  }

  async _persist() {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    await saveAtomic(this.file, this.state);
  }

  // Serialized read-modify-write. All state mutations route through here so
  // concurrent callers are safe and every mutation hits disk before returning.
  update(fn) {
    const run = this.queue.then(async () => {
      const result = await fn(this.state);
      await this._persist();
      return result;
    });
    // Keep the chain alive even if a write fails; store the rejection for the
    // caller but don't poison later updates with an unhandled rejection.
    this.queue = run.catch(() => {});
    return run;
  }
}

module.exports = { Store, freshState, dataFile };
