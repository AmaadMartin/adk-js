/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

/** A Go module that the cross-language suite compiles and then executes. */
export interface GoFixture {
  /** Directory holding the fixture's `go.mod`. */
  moduleDir: string;
  /** Path that `go build -o` writes the fixture's executable to. */
  binaryPath: string;
}

/**
 * Resolved from `import.meta.url` rather than `__dirname` because this module
 * is imported both by the Vitest global setup and by test-worker code.
 */
const A2A_DIR = path.dirname(fileURLToPath(import.meta.url));

const BIN_DIR = path.resolve(A2A_DIR, '..', '.bin');

const EXE_SUFFIX = process.platform === 'win32' ? '.exe' : '';

export const GO_CLIENT_FIXTURE: GoFixture = {
  moduleDir: path.join(A2A_DIR, 'go_ts', 'go_client'),
  binaryPath: path.join(BIN_DIR, `go_client${EXE_SUFFIX}`),
};

export const GO_BACKEND_FIXTURE: GoFixture = {
  moduleDir: path.join(A2A_DIR, 'ts_go', 'go_backend'),
  binaryPath: path.join(BIN_DIR, `go_backend${EXE_SUFFIX}`),
};

export const GO_FIXTURES: readonly GoFixture[] = [
  GO_CLIENT_FIXTURE,
  GO_BACKEND_FIXTURE,
];

/**
 * Compiles one Go fixture to its `binaryPath`.
 *
 * Both `go` invocations inherit stdio and are allowed to throw: the toolchain
 * prints its own diagnostics, and the thrown error names the failing command.
 */
export function buildGoFixture(fixture: GoFixture): void {
  if (!fs.existsSync(path.join(fixture.moduleDir, 'go.sum'))) {
    execFileSync('go', ['mod', 'tidy'], {
      cwd: fixture.moduleDir,
      stdio: 'inherit',
      env: process.env,
    });
  }
  fs.mkdirSync(path.dirname(fixture.binaryPath), {recursive: true});
  execFileSync('go', ['build', '-o', fixture.binaryPath, '.'], {
    cwd: fixture.moduleDir,
    stdio: 'inherit',
    env: process.env,
  });
}
