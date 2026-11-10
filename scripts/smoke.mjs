// Installs the packed tarball into a fresh project and checks what a consumer does:
// ESM import and CJS require of each entry, types under NodeNext, and drizzle-kit loading a schema.
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const run = (cmd, cwd) => {
  try {
    return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch (error) {
    throw new Error(`${cmd} failed:\n${error.stdout}${error.stderr}`);
  }
};

const dir = mkdtempSync(join(tmpdir(), 'notify-smoke-'));
const tarball = join(dir, run(`npm pack --silent --pack-destination ${dir}`, root).split('\n').pop());
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }));
run(`npm i --silent --no-audit --no-fund ${tarball} drizzle-orm@0.45.2 drizzle-kit typescript@5.9.3 @types/node@24`, dir);

const entries = ['@devmonks/notify', '@devmonks/notify/drizzle'];
for (const entry of entries) {
  run(`node -e "import('${entry}').then((m) => { if (!Object.keys(m).length) process.exit(1); })"`, dir);
  run(`node --input-type=commonjs -e "require('${entry}')"`, dir);
}

writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: true, types: ['node'] },
  include: ['schema.ts'],
}));
writeFileSync(join(dir, 'schema.ts'), `import { pgTable, uuid } from 'drizzle-orm/pg-core';
import { createNotifier } from '@devmonks/notify';
import { drizzleStore, notifyTables } from '@devmonks/notify/drizzle';
export const users = pgTable('user', { id: uuid().primaryKey() });
export const { notifications, devices, notificationPrefs, notificationSettings, notificationDeliveries } = notifyTables({ users });
export const makeStore = (db: Parameters<typeof drizzleStore>[0]) =>
  drizzleStore(db, notifyTables({ users }), { getUser: async (id) => ({ email: id }) });
void createNotifier;
`);
run('npx tsc -p .', dir);

writeFileSync(join(dir, 'drizzle.config.ts'), `export default { dialect: 'postgresql', schema: './schema.ts', out: './drizzle' };`);
const out = run('npx drizzle-kit generate --name smoke', dir);
if (!/6 tables/.test(out)) throw new Error(`drizzle-kit did not see 6 tables:\n${out}`);

console.log(`smoke ok: ${entries.join(', ')} (ESM + CJS), NodeNext types, drizzle-kit generate`);
