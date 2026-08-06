/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {execFileSync, spawnSync} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import type {GoFixture} from './go_fixtures.js';
import {buildGoFixture, GO_FIXTURES} from './go_fixtures.js';

/**
 * Budget (ms) for a test that shells out to the Go toolchain. The temporary
 * module has no external dependencies, so `go mod tidy` plus `go build`
 * measured well under a second locally; the rest is headroom for a cold
 * toolchain on a CI runner.
 */
const GO_TOOLCHAIN_TIMEOUT_MS = 60000;

const GREETING = 'hello from the temporary go fixture';

const tempRoots: string[] = [];

/**
 * Writes a two-module Go tree whose `app` module imports `helper` through a
 * `replace` directive but does not require it. `go build` only succeeds once
 * `go mod tidy` has added the missing `require`, which makes the tidy step
 * observable without mocking `node:child_process`.
 */
function createTempFixture(): GoFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-go-fixture-'));
  tempRoots.push(root);

  const helperDir = path.join(root, 'helper');
  fs.mkdirSync(helperDir);
  fs.writeFileSync(
    path.join(helperDir, 'go.mod'),
    'module helper\n\ngo 1.25.0\n',
  );
  fs.writeFileSync(
    path.join(helperDir, 'helper.go'),
    `package helper\n\nfunc Greeting() string { return "${GREETING}" }\n`,
  );

  const moduleDir = path.join(root, 'app');
  fs.mkdirSync(moduleDir);
  fs.writeFileSync(
    path.join(moduleDir, 'go.mod'),
    'module app\n\ngo 1.25.0\n\nreplace helper => ../helper\n',
  );
  fs.writeFileSync(
    path.join(moduleDir, 'main.go'),
    'package main\n\nimport (\n\t"fmt"\n\n\t"helper"\n)\n\nfunc main() { fmt.Print(helper.Greeting()) }\n',
  );

  return {moduleDir, binaryPath: path.join(root, 'bin', 'app')};
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

describe('GO_FIXTURES', () => {
  it('names a Go module and a git-ignored binary for each fixture', () => {
    expect(GO_FIXTURES.length).toBeGreaterThan(0);
    for (const fixture of GO_FIXTURES) {
      expect(fs.existsSync(path.join(fixture.moduleDir, 'go.mod'))).toBe(true);
      const ignored = spawnSync('git', ['check-ignore', fixture.binaryPath]);
      expect(ignored.status).toBe(0);
    }
  });
});

describe('buildGoFixture', () => {
  it(
    'runs go mod tidy when go.sum is absent and builds a runnable binary',
    () => {
      const fixture = createTempFixture();

      buildGoFixture(fixture);

      expect(
        fs.readFileSync(path.join(fixture.moduleDir, 'go.mod'), 'utf8'),
      ).toContain('require helper');
      expect(execFileSync(fixture.binaryPath, [], {encoding: 'utf8'})).toBe(
        GREETING,
      );
    },
    GO_TOOLCHAIN_TIMEOUT_MS,
  );

  it(
    'skips go mod tidy when go.sum exists, so the unresolved import fails the build',
    () => {
      const fixture = createTempFixture();
      fs.writeFileSync(path.join(fixture.moduleDir, 'go.sum'), '');

      expect(() => buildGoFixture(fixture)).toThrow(/go build/);

      expect(
        fs.readFileSync(path.join(fixture.moduleDir, 'go.mod'), 'utf8'),
      ).not.toContain('require helper');
      expect(fs.existsSync(fixture.binaryPath)).toBe(false);
    },
    GO_TOOLCHAIN_TIMEOUT_MS,
  );
});
