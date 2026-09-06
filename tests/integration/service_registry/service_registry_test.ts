/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Runs the built CLI in its own process against an agent directory that
// declares a custom session backend in services.ts. Nothing is mocked: the CLI
// compiles and imports the services file, the registry resolves the scheme,
// and the replayed run reaches the agent. It is hermetic, with no network and
// no model call.

import {getServiceRegistry, loadServicesModule} from '@google/adk-devtools';
import {execFile} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const execFileAsync = promisify(execFile);

const AGENT_DIR = fileURLToPath(new URL('./agent', import.meta.url));
const CLI_ENTRYPOINT = fileURLToPath(
  new URL('../../../dev/dist/esm/cli_entrypoint.js', import.meta.url),
);

describe('service registry', () => {
  let scratch = '';

  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'adk_service_registry-'));
  });

  afterEach(async () => {
    await fs.rm(scratch, {recursive: true, force: true});
  });

  it('builds the session service the agent directory declares', async () => {
    const marker = path.join(scratch, 'built.txt');
    const replay = path.join(scratch, 'replay.json');
    await fs.writeFile(replay, JSON.stringify({state: {}, queries: []}));

    await execFileAsync(process.execPath, [
      CLI_ENTRYPOINT,
      'run',
      path.join(AGENT_DIR, 'agent.ts'),
      '--replay',
      replay,
      '--session_service_uri',
      `fake://${marker}`,
    ]);

    expect(await fs.readFile(marker, 'utf-8')).toBe(`fake://${marker}`);
  });

  it('rejects an invalid replay file before the agent runs', async () => {
    const replay = path.join(scratch, 'bad.json');
    await fs.writeFile(replay, JSON.stringify({state: {}}));

    await expect(
      execFileAsync(process.execPath, [
        CLI_ENTRYPOINT,
        'run',
        path.join(AGENT_DIR, 'agent.ts'),
        '--replay',
        replay,
      ]),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining(
        `Invalid run input file ${replay}: queries:`,
      ),
    });
  });

  it('registers the scheme through the public entry point', async () => {
    const marker = path.join(scratch, 'direct.txt');
    await loadServicesModule(AGENT_DIR);

    const service = await getServiceRegistry().createSessionService(
      `fake://${marker}`,
    );

    expect(service).toBeDefined();
    expect(await fs.readFile(marker, 'utf-8')).toBe(`fake://${marker}`);
  });
});
