/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawnSync, type SpawnSyncReturns} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/check_phantom_deps.mjs',
);

const ALLOWLIST_RELATIVE_PATH = 'scripts/phantom_deps_allowlist.json';

/** Runs the real checker over a fixture tree, as CI invokes it. */
function runChecker(rootDir: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [SCRIPT_PATH, rootDir], {
    encoding: 'utf8',
  });
}

function writeFixture(rootDir: string, files: Record<string, string>): void {
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    fs.writeFileSync(filePath, contents);
  }
}

describe('check_phantom_deps', () => {
  let fixtureRoot: string;

  beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-phantom-deps-'));
  });

  afterEach(() => {
    fs.rmSync(fixtureRoot, {recursive: true, force: true});
  });

  describe('resolution path', () => {
    it('passes when the root manifest declares the package', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({dependencies: {'left-pad': '^1.0.0'}}),
        'a.ts': `import leftPad from 'left-pad';\n`,
      });

      const result = runChecker(fixtureRoot);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('No phantom dependencies found');
    });

    it('fails when no manifest on the path declares the package', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        'a.ts': `import leftPad from 'left-pad';\n`,
      });

      const result = runChecker(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('left-pad');
      expect(result.stdout).toContain('a.ts');
      expect(result.stdout).toContain('declare it in: package.json');
    });

    it('passes when the nearest manifest declares the package', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        'pkg/package.json': JSON.stringify({
          dependencies: {'left-pad': '^1.0.0'},
        }),
        'pkg/a.ts': `import leftPad from 'left-pad';\n`,
      });

      expect(runChecker(fixtureRoot).status).toBe(0);
    });

    it('lets the root manifest satisfy a nested file with no manifest', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({dependencies: {'left-pad': '^1.0.0'}}),
        'tests/a.ts': `import leftPad from 'left-pad';\n`,
      });

      expect(runChecker(fixtureRoot).status).toBe(0);
    });

    it('treats a nested manifest as additive, not exclusive', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({dependencies: {'left-pad': '^1.0.0'}}),
        'fx/package.json': JSON.stringify({
          dependencies: {'local-stub': 'file:./stub'},
        }),
        'fx/a.ts':
          `import stub from 'local-stub';\n` +
          `import leftPad from 'left-pad';\n`,
      });

      expect(runChecker(fixtureRoot).status).toBe(0);
    });

    it('rejects a package hoisted from a sibling workspace', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({workspaces: ['a', 'b']}),
        'a/package.json': JSON.stringify({name: '@x/a'}),
        'b/package.json': JSON.stringify({
          name: '@x/b',
          dependencies: {'left-pad': '^1.0.0'},
        }),
        'a/a.ts': `import leftPad from 'left-pad';\n`,
      });

      const result = runChecker(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('declare it in: a/package.json');
    });

    it('reports the root manifest when no manifest exists at all', () => {
      writeFixture(fixtureRoot, {
        'a/b/a.ts': `import leftPad from 'left-pad';\n`,
      });

      const result = runChecker(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('declare it in: package.json');
    });

    it.each([
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ])('accepts a package declared in %s', (field) => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({[field]: {'left-pad': '^1.0.0'}}),
        'a.ts': `import leftPad from 'left-pad';\n`,
      });

      expect(runChecker(fixtureRoot).status).toBe(0);
    });
  });

  describe('workspace packages', () => {
    it('always accepts a workspace package name', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'root', workspaces: ['a']}),
        'a/package.json': JSON.stringify({name: '@x/a'}),
        'tests/t.ts': `import a from '@x/a';\nimport root from 'root';\n`,
      });

      expect(runChecker(fixtureRoot).status).toBe(0);
    });

    it('ignores a workspace entry with no directory and one with no name', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({workspaces: ['missing', 'a']}),
        'a/package.json': JSON.stringify({dependencies: {}}),
        'a/a.ts': `import leftPad from 'left-pad';\n`,
      });

      const result = runChecker(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('left-pad');
    });
  });

  describe('specifier classification', () => {
    it('skips Node built-ins in both bare and node: form', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        'a.ts':
          `import fs from 'node:fs';\n` +
          `import path from 'path';\n` +
          `import promises from 'node:fs/promises';\n`,
      });

      expect(runChecker(fixtureRoot).status).toBe(0);
    });

    it('skips relative, absolute and subpath-import specifiers', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        'a.ts':
          `import b from './b.js';\n` +
          `import c from '../c.js';\n` +
          `import d from '/abs/d.js';\n` +
          `import e from 'C:\\\\abs\\\\e.js';\n` +
          `import f from '#internal';\n` +
          `import g from '';\n`,
      });

      expect(runChecker(fixtureRoot).status).toBe(0);
    });

    it('maps a deep subpath to its package name', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        'a.ts':
          `import x from '@scope/pkg/build/src/x.js';\n` +
          `import y from 'pkg/lib/y.js';\n`,
      });

      const result = runChecker(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('@scope/pkg\n');
      expect(result.stdout).toContain('pkg\n');
      expect(result.stdout).not.toContain('build/src/x.js');
      expect(result.stdout).not.toContain('lib/y.js');
    });

    it('ignores a bare @scope with no package segment', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        'a.ts': `import x from '@scope';\nimport y from '@scope/';\n`,
      });

      expect(runChecker(fixtureRoot).status).toBe(0);
    });
  });

  describe('import syntax', () => {
    it.each([
      ['a type-only import', `import type {X} from 'left-pad';\n`],
      ['a side-effect import', `import 'left-pad';\n`],
      ['a default import', `import leftPad from 'left-pad';\n`],
      ['a re-export', `export {x} from 'left-pad';\n`],
      ['a star re-export', `export * from 'left-pad';\n`],
      ['a literal dynamic import', `await import('left-pad');\n`],
      ['an import-equals require', `import x = require('left-pad');\n`],
      ['an import type node', `let x: import('left-pad').Foo;\n`],
      ['a require.resolve call', `require.resolve('left-pad');\n`],
    ])('detects %s', (_name, source) => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        'a.ts': source,
      });

      const result = runChecker(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('left-pad');
    });

    it('detects require() in a .cjs file', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        'a.cjs': `const leftPad = require('left-pad');\n`,
      });

      const result = runChecker(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('left-pad');
    });

    it('ignores a dynamic import whose specifier is not a plain literal', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        'a.ts':
          'const n = 1;\n' +
          'const v = "left-pad";\n' +
          'await import(`./${n}.js`);\n' +
          'await import(v);\n',
      });

      expect(runChecker(fixtureRoot).status).toBe(0);
    });

    it('ignores require(...) written inside a string or template literal', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        'a.ts':
          "const s = `require('ts-node/register');`;\n" +
          'const t = "require(\'left-pad\')";\n',
      });

      const result = runChecker(fixtureRoot);

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('ts-node');
    });

    it('ignores calls that are not module loads', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        'a.ts':
          `declare function helper(name: string): void;\n` +
          `declare const obj: {resolve(name: string): void};\n` +
          `declare const outer: {inner: {resolve(name: string): void}};\n` +
          `declare const req: {cache(name: string): void};\n` +
          `helper('left-pad');\n` +
          `obj.resolve('left-pad');\n` +
          `outer.inner.resolve('left-pad');\n` +
          `req.cache('left-pad');\n`,
      });

      expect(runChecker(fixtureRoot).status).toBe(0);
    });

    it('ignores an export with no module specifier', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        'a.ts': `const x = 1;\nexport {x};\n`,
      });

      expect(runChecker(fixtureRoot).status).toBe(0);
    });

    it('ignores an import type node with a non-literal argument', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        'a.ts': `type A = string;\ntype B = import(A).Foo;\n`,
      });

      expect(runChecker(fixtureRoot).status).toBe(0);
    });

    it.each(['a.ts', 'a.tsx', 'a.js', 'a.mjs', 'a.cjs'])(
      'scans %s',
      (fileName) => {
        writeFixture(fixtureRoot, {
          'package.json': JSON.stringify({name: 'fixture'}),
          [fileName]: `import leftPad from 'left-pad';\n`,
        });

        const result = runChecker(fixtureRoot);

        expect(result.status).toBe(1);
        expect(result.stdout).toContain(fileName);
      },
    );

    it('skips generated and dependency directories', () => {
      const source = `import leftPad from 'left-pad';\n`;
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        'node_modules/pkg/index.js': source,
        'dist/out.js': source,
        'coverage/report.js': source,
        '.cache/cached.js': source,
        '.adk_build_cache/adk_agent_loader/abc123/agent.js': source,
        'api-reference/docs.js': source,
        '.git/hook.js': source,
      });

      expect(runChecker(fixtureRoot).status).toBe(0);
    });
  });

  describe('allowlist', () => {
    it('suppresses an allowlisted violation', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        'a.ts': `import leftPad from 'left-pad';\n`,
        [ALLOWLIST_RELATIVE_PATH]: JSON.stringify({
          'package.json': ['left-pad'],
        }),
      });

      expect(runChecker(fixtureRoot).status).toBe(0);
    });

    it('fails on an allowlist entry that matches no violation', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({dependencies: {'left-pad': '^1.0.0'}}),
        'a.ts': `import leftPad from 'left-pad';\n`,
        [ALLOWLIST_RELATIVE_PATH]: JSON.stringify({
          'package.json': ['left-pad'],
        }),
      });

      const result = runChecker(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('Allowlist entry is no longer needed');
      expect(result.stdout).toContain('package.json: left-pad');
    });

    it('scopes an allowlist entry to the manifest it names', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        'a/package.json': JSON.stringify({name: 'nested'}),
        'a/a.ts': `import leftPad from 'left-pad';\n`,
        [ALLOWLIST_RELATIVE_PATH]: JSON.stringify({
          'package.json': ['left-pad'],
        }),
      });

      const result = runChecker(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('declare it in: a/package.json');
      expect(result.stdout).toContain('Allowlist entry is no longer needed');
    });

    it('treats a missing allowlist file as empty', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({dependencies: {'left-pad': '^1.0.0'}}),
        'a.ts': `import leftPad from 'left-pad';\n`,
      });

      expect(runChecker(fixtureRoot).status).toBe(0);
    });
  });

  describe('malformed input', () => {
    it('fails naming a manifest that is not valid JSON', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        'nested/package.json': '{',
        'nested/a.ts': `import leftPad from 'left-pad';\n`,
      });

      const result = runChecker(fixtureRoot);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        path.join(fixtureRoot, 'nested', 'package.json'),
      );
    });

    it('fails naming a manifest that is not a JSON object', () => {
      writeFixture(fixtureRoot, {
        'package.json': 'null',
        'a.ts': `import leftPad from 'left-pad';\n`,
      });

      const result = runChecker(fixtureRoot);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('expected a JSON object');
    });

    it('fails naming an allowlist that is not valid JSON', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        [ALLOWLIST_RELATIVE_PATH]: '{',
      });

      const result = runChecker(fixtureRoot);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        path.join(fixtureRoot, ALLOWLIST_RELATIVE_PATH),
      );
    });

    it('fails when the allowlist is not a JSON object', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        [ALLOWLIST_RELATIVE_PATH]: '[]',
      });

      const result = runChecker(fixtureRoot);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('expected a JSON object');
    });

    it('fails when an allowlist entry is not an array', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        [ALLOWLIST_RELATIVE_PATH]: JSON.stringify({'package.json': 'left-pad'}),
      });

      const result = runChecker(fixtureRoot);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('must map to an array');
    });
  });

  describe('report', () => {
    it('sorts by package then manifest and is byte-identical across runs', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        'b.ts': `import zod from 'zod';\nimport aaa from 'aaa-pkg';\n`,
        'a.ts': `import zod from 'zod';\nimport mid from 'mid-pkg';\n`,
      });

      const first = runChecker(fixtureRoot);
      const second = runChecker(fixtureRoot);

      expect(first.status).toBe(1);
      expect(second.stdout).toBe(first.stdout);
      expect(first.stdout.indexOf('aaa-pkg')).toBeLessThan(
        first.stdout.indexOf('mid-pkg'),
      );
      expect(first.stdout.indexOf('mid-pkg')).toBeLessThan(
        first.stdout.indexOf('zod'),
      );

      const zodBlock = first.stdout.slice(first.stdout.indexOf('zod\n'));
      expect(zodBlock.indexOf('a.ts')).toBeLessThan(zodBlock.indexOf('b.ts'));
    });

    it('reports POSIX paths on every platform', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        'a/b/c.ts': `import leftPad from 'left-pad';\n`,
      });

      const result = runChecker(fixtureRoot);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('a/b/c.ts');
      expect(result.stdout).not.toContain('\\');
    });

    it('counts one violation in the singular', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        'a.ts': `import leftPad from 'left-pad';\n`,
      });

      expect(runChecker(fixtureRoot).stdout).toContain(
        'Found 1 undeclared dependency.',
      );
    });

    it('counts several violations in the plural', () => {
      writeFixture(fixtureRoot, {
        'package.json': JSON.stringify({name: 'fixture'}),
        'a.ts': `import leftPad from 'left-pad';\nimport zod from 'zod';\n`,
      });

      expect(runChecker(fixtureRoot).stdout).toContain(
        'Found 2 undeclared dependencies.',
      );
    });
  });
});
