'use strict';

// Syntax-checks every .js file in the project (stdlib only).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== '.git') walk(p, out);
    } else if (e.name.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

const root = path.join(__dirname, '..');
const files = walk(root).sort();
for (const f of files) {
  execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
}
console.log(`syntax OK: ${files.length} files`);
