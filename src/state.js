'use strict';

// JSON-file persistence with atomic temp-file rename and an in-process async
// write lock. TOP40_DATA_FILE overrides the data file location (tests, deploy).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { currentChartHour, hourDiff } = require('./dates');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'state.json');

function dataFile() {
  return process.env.TOP40_DATA_FILE || DEFAULT_FILE;
}

function freshState(now = new Date()) {
  return {
    version: 2,
    seed: crypto.randomInt(0, 2 ** 31),
    originHour: currentChartHour(now),
    lastGeneratedHour: null,
    chartFilled: false,
    releases: [],
    submissions: [],
    snapshots: [],
    activeSongIds: [],
    corrections: [],
    counters: { release: 0, submission: 0 },
  };
}

function validateState(state) {
  hourDiff(state.originHour, state.originHour);
  if (state.lastGeneratedHour) hourDiff(state.originHour, state.lastGeneratedHour);
  for (const key of ['releases', 'submissions', 'snapshots', 'activeSongIds', 'corrections']) {
    if (!Array.isArray(state[key])) throw new Error(`Invalid v2 state: ${key}`);
  }
  if (!state.counters || !['release', 'submission'].every(key => Number.isInteger(state.counters[key]) && state.counters[key] >= 0) ||
      !Number.isInteger(state.seed) || typeof state.chartFilled !== 'boolean') {
    throw new Error('Invalid v2 state metadata');
  }
  for (const release of state.releases) hourDiff(state.originHour, release.releasedHour);
  for (const sub of state.submissions) {
    if (sub.status === 'pending') hourDiff(state.originHour, sub.expectedChartHour);
  }
  const hours = new Set();
  for (const snapshot of state.snapshots) {
    hourDiff(state.originHour, snapshot.hour);
    if (hours.has(snapshot.hour) || !Array.isArray(snapshot.entries)) throw new Error('Invalid v2 snapshots');
    hours.add(snapshot.hour);
  }
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
    if (raw === null) {
      this.state = freshState();
      await this._persist();
    } else {
      if (!raw.trim()) throw new Error(`Empty state file: ${this.file}; refusing automatic reset`);
      this.state = JSON.parse(raw); // corrupt data fails loudly; never reset on boot
      if (!this.state || this.state.version !== 2) {
        throw new Error(`Unsupported state version in ${this.file}; use scripts/reset-hourly.js explicitly with the service stopped`);
      }
      validateState(this.state);
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
      const before = structuredClone(this.state);
      try {
        const result = await fn(this.state);
        await this._persist();
        return result;
      } catch (error) {
        this.state = before; // failed ticks must remain retryable, without counted sales
        throw error;
      }
    });
    // Keep the chain alive even if a write fails; store the rejection for the
    // caller but don't poison later updates with an unhandled rejection.
    this.queue = run.catch(() => {});
    return run;
  }
}

module.exports = { Store, freshState, dataFile };
