'use strict';

// Offline only: stop the service and back up its state before running this.
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../src/state');
const { transitionCatalogue } = require('../src/chart');

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/transition-catalogue.js /absolute/path/to/state.json (service stopped)');
  const file = path.resolve(process.argv[2]);
  if (!(await fs.promises.readFile(file, 'utf8')).trim()) throw new Error('Refusing to migrate empty state');
  const store = new Store(file);
  await store.init();
  const result = await store.update(state => transitionCatalogue(state));
  console.log(JSON.stringify({
    created: result.created,
    day: store.state.catalogueTransition.day,
    retired: store.state.catalogueTransition.retiredReleaseIds.length,
    entries: result.snapshot?.entries.length ?? 0,
  }));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
