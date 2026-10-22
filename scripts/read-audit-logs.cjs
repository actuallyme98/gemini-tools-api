#!/usr/bin/env node
// Local/SSH admin utility. The journal and archived images have no public route.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--'))
    throw new Error('Missing value for ' + name);
  return args[index + 1];
}
async function main() {
  const directory = path.resolve(
    option('--dir') || process.env.AUDIT_LOG_DIR || './logs',
  );
  const requestId = option('--request');
  const day = option('--day');
  const limit = Number(option('--limit') || 50);
  if (requestId && !/^[a-f0-9-]{36}$/i.test(requestId))
    throw new Error('Invalid request UUID');
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day))
    throw new Error('Use --day YYYY-MM-DD (UTC)');
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000)
    throw new Error('Limit must be 1..10000');
  const days = (await fs.promises.readdir(directory, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isDirectory() &&
        /^\d{4}-\d{2}-\d{2}$/.test(entry.name) &&
        (!day || entry.name === day),
    )
    .map((entry) => entry.name)
    .sort();
  const recent = [];
  let count = 0;
  for (const entry of days) {
    const file = path.join(directory, entry, 'events.jsonl');
    try {
      await fs.promises.access(file);
    } catch {
      continue;
    }
    const lines = readline.createInterface({
      input: fs.createReadStream(file),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (requestId) {
        if (event.requestId === requestId) {
          console.log(JSON.stringify(event));
          count++;
        }
      } else if (
        [
          'http_completed',
          'background_job_completed',
          'background_job_failed',
        ].includes(event.event)
      ) {
        recent.push(event);
        if (recent.length > limit) recent.shift();
      }
    }
  }
  if (!requestId)
    for (const event of recent) {
      console.log(JSON.stringify(event));
      count++;
    }
  if (!count) console.error('No matching log records.');
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
