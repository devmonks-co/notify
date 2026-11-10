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
    expect(all.filter((s) => s.startsWith('/email/') || s.startsWith('/drizzle/'))).toEqual([]);
  });
});
