/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {execFile} from 'node:child_process';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {describe, expect, it} from 'vitest';

const execFileAsync = promisify(execFile);

const fixtureDir = path.join(
  process.cwd(),
  'tests/integration/agent_loader/import_url',
);
const agentPath = path.join(fixtureDir, 'agent.mjs');
const driverPath = path.join(fixtureDir, 'load_twice.mjs');

interface LoadResult {
  firstUrl: string;
  secondUrl: string;
  sameModule: boolean;
}

async function loadTwice(reloadable: boolean): Promise<LoadResult> {
  const {stdout} = await execFileAsync('node', [
    driverPath,
    agentPath,
    String(reloadable),
  ]);
  return JSON.parse(stdout) as LoadResult;
}

describe('AgentFile import URL', () => {
  it('imports the agent at its own URL when reloading is off', async () => {
    const result = await loadTwice(false);

    expect(result.firstUrl).toBe(pathToFileURL(agentPath).href);
    expect(result.secondUrl).toBe(result.firstUrl);
    expect(result.sameModule).toBe(true);
  });

  it('re-imports the agent under a unique URL when reloading is on', async () => {
    const result = await loadTwice(true);

    const first = new URL(result.firstUrl);
    expect(first.pathname).toBe(
      new URL(pathToFileURL(agentPath).href).pathname,
    );
    expect(first.search).toMatch(/^\?t=\d+_[a-z0-9]+$/);
    expect(result.secondUrl).not.toBe(result.firstUrl);
    expect(result.sameModule).toBe(false);
  });
});
