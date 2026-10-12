// CLI for the morning brief (and for setup). Reads INBOX_KEY from ../.env.
//   node tools/inbox.mjs new            → JSON of rows whose status is "חדש"
//   node tools/inbox.mjs seen <id> ...  → marks rows as "נקלט" (the phone shows ✓✓)
//   node tools/inbox.mjs purge-tests    → deletes rows whose id starts with test-
//   node tools/inbox.mjs pair <code>    → registers this computer as a device, writes INBOX_KEY to .env
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwPIplTyvr0gUPlPTsVMVOL1WcgGw-sc_3GNUQI0MpcEZDFskeMRpskI1nJiyaR7AJP/exec';
const ENV = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');

function readKey() {
  if (!existsSync(ENV)) return null;
  const m = readFileSync(ENV, 'utf8').match(/^INBOX_KEY=(.+)$/m);
  return m ? m[1].trim() : null;
}

async function api(body) {
  const res = await fetch(SCRIPT_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body)
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error('Not JSON (is the script authorised?): ' + text.slice(0, 120)); }
}

const [cmd, ...args] = process.argv.slice(2);
const key = readKey();

if (cmd === 'pair') {
  const newKey = randomBytes(32).toString('hex');
  const r = await api({ action: 'pair', code: args[0], key: newKey, name: 'העוזר (מחשב)' });
  if (!r.success) { console.error(r.message); process.exit(1); }
  const prev = existsSync(ENV) ? readFileSync(ENV, 'utf8').replace(/^INBOX_KEY=.*\n?/m, '') : '';
  writeFileSync(ENV, prev + `INBOX_KEY=${newKey}\n`);
  console.log('paired; key saved to .env');
} else if (cmd === 'new') {
  const r = await api({ action: 'list', key, limit: 50 });
  if (!r.success) { console.error(r.message); process.exit(1); }
  console.log(JSON.stringify(r.items.filter(i => i.status === 'חדש').reverse(), null, 1));
} else if (cmd === 'seen') {
  const r = await api({ action: 'markSeen', key, ids: args });
  if (!r.success) { console.error(r.message); process.exit(1); }
  console.log(`marked ${r.marked}`);
} else if (cmd === 'purge-tests') {
  console.log(JSON.stringify(await api({ action: 'purgeTests', key, ids: args })));
} else {
  console.log('usage: node tools/inbox.mjs new | seen <id...> | pair <code>');
}
