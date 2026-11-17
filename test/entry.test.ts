import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

/** Every module specifier reachable from [entry], following relative imports (type-only ones too: the package ships source). */
function specifiers(entry: string, seen = new Set<string>(), out = new Set<string>()): Set<string> {
  if (seen.has(entry)) return out;
  seen.add(entry);
  for (const m of readFileSync(entry, 'utf8').matchAll(/\bfrom\s+'([^']+)'/g)) {
    const spec = m[1]!;
    out.add(spec.startsWith('.') ? resolve(dirname(entry), spec).replace(src, '') : spec);
    if (spec.startsWith('.')) specifiers(resolve(dirname(entry), spec.replace(/\.js$/, '.ts')), seen, out);
  }
  return out;
}

describe('core entry', () => {
  it('imports no package (react, react-email, drizzle) and nothing from the optional entries', () => {
    const all = [...specifiers(resolve(src, 'index.ts'))];
    expect(all.length).toBeGreaterThan(3);
    expect(all.filter((s) => !s.startsWith('/'))).toEqual([]);
    expect(all.filter((s) => /^\/(email|drizzle|sqlite|d1|shared)\//.test(s))).toEqual([]);
  });
});

const packages = (entry: string) => [...specifiers(resolve(src, entry))].filter((s) => !s.startsWith('/')).sort();
const internal = (entry: string) => [...specifiers(resolve(src, entry))].filter((s) => s.startsWith('/'));

describe('sqlite entry', () => {
  it('imports only drizzle-orm (no pg-core) and nothing from the Postgres entry', () => {
    expect(packages('sqlite/index.ts')).toEqual(['drizzle-orm', 'drizzle-orm/batch', 'drizzle-orm/sqlite-core']);
    expect(internal('sqlite/index.ts').filter((s) => s.startsWith('/drizzle/'))).toEqual([]);
  });
});

describe('d1 entry', () => {
  it('adds only drizzle-orm/d1 to the sqlite entry', () => {
    expect(packages('d1/index.ts')).toEqual(['drizzle-orm', 'drizzle-orm/batch', 'drizzle-orm/d1', 'drizzle-orm/sqlite-core']);
    expect(internal('d1/index.ts').filter((s) => s.startsWith('/drizzle/'))).toEqual([]);
  });

  it('imports drizzle-orm/d1 for types only', () => {
    expect(readFileSync(resolve(src, 'd1/index.ts'), 'utf8')).toMatch(/^import type \{ DrizzleD1Database \} from 'drizzle-orm\/d1';$/m);
  });
});
