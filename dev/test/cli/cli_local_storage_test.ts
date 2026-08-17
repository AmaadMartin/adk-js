/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DatabaseSessionService,
  InMemoryArtifactService,
  InMemorySessionService,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {createProgram} from '../../src/cli/cli.js';
import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {
  PerAgentDatabaseSessionService,
  PerAgentFileArtifactService,
} from '../../src/utils/local_storage.js';

vi.mock('../../src/server/adk_api_server', () => {
  return {
    AdkApiServer: vi.fn(() => ({
      start: vi.fn(),
    })),
  };
});

const MANAGED_ENV_VARS = [
  'DATABASE_URL',
  'ADK_DISABLE_LOCAL_STORAGE',
  'ADK_FORCE_LOCAL_STORAGE',
  'K_SERVICE',
  'KUBERNETES_SERVICE_HOST',
];

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);

    return true;
  } catch (_e: unknown) {
    return false;
  }
}

/**
 * Removes the temporary tree, tolerating a file the process still holds open.
 *
 * `DatabaseSessionService` exposes no `close()`, so its SQLite handle stays
 * open for the life of the test process. Windows refuses to unlink an open
 * file, and a cleanup failure must not fail a test that already passed. The
 * operating system reclaims the temporary directory.
 */
async function removeTempTree(root: string): Promise<void> {
  try {
    await fs.rm(root, {recursive: true, force: true});
  } catch (_e: unknown) {
    return;
  }
}

describe('CLI local storage wiring', () => {
  let program: ReturnType<typeof createProgram>;
  let agentsDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    vi.clearAllMocks();
    program = createProgram();
    program.exitOverride();
    agentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk_cli_storage-'));
    savedEnv = Object.fromEntries(
      MANAGED_ENV_VARS.map((name) => [name, process.env[name]]),
    );
    for (const name of MANAGED_ENV_VARS) {
      delete process.env[name];
    }
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await removeTempTree(agentsDir);
    vi.restoreAllMocks();
  });

  const parse = async (args: string[]) => {
    await program.parseAsync(['node', 'cli_entrypoint.js', ...args]);
  };

  const serverOptions = () => vi.mocked(AdkApiServer).mock.calls[0][0];

  it('gives adk web per-agent local storage by default', async () => {
    await parse(['web', agentsDir]);

    expect(serverOptions().sessionService).toBeInstanceOf(
      PerAgentDatabaseSessionService,
    );
    expect(serverOptions().artifactService).toBeInstanceOf(
      PerAgentFileArtifactService,
    );
  });

  it('gives adk api_server per-agent local storage by default', async () => {
    await parse(['api_server', agentsDir]);

    expect(serverOptions().sessionService).toBeInstanceOf(
      PerAgentDatabaseSessionService,
    );
    expect(serverOptions().artifactService).toBeInstanceOf(
      PerAgentFileArtifactService,
    );
  });

  it('roots storage at the parent directory of a single agent file', async () => {
    const agentFile = path.join(agentsDir, 'weather.ts');
    await fs.writeFile(agentFile, '');

    await parse(['web', agentFile]);
    const sessionService = serverOptions().sessionService;
    if (!sessionService) {
      expect.fail('adk web started without a session service');
    }
    await sessionService.createSession({appName: 'weather', userId: 'u1'});

    expect(serverOptions().agentsDir).toBe(agentFile);
    expect(
      await exists(path.join(agentsDir, 'weather', '.adk', 'session.db')),
    ).toBe(true);
  });

  it('lets --session_service_uri win for sessions only', async () => {
    await parse(['web', agentsDir, '--session_service_uri', 'memory://']);

    expect(serverOptions().sessionService).toBeInstanceOf(
      InMemorySessionService,
    );
    expect(serverOptions().artifactService).toBeInstanceOf(
      PerAgentFileArtifactService,
    );
  });

  it('lets --artifact_service_uri win for artifacts only', async () => {
    await parse(['web', agentsDir, '--artifact_service_uri', 'memory://']);

    expect(serverOptions().sessionService).toBeInstanceOf(
      PerAgentDatabaseSessionService,
    );
    expect(serverOptions().artifactService).toBeInstanceOf(
      InMemoryArtifactService,
    );
  });

  it('keeps both services in memory for --use_local_storage false', async () => {
    await parse(['web', agentsDir, '--use_local_storage', 'false']);

    expect(serverOptions().sessionService).toBeInstanceOf(
      InMemorySessionService,
    );
    expect(serverOptions().artifactService).toBeInstanceOf(
      InMemoryArtifactService,
    );
    expect(await fs.readdir(agentsDir)).toEqual([]);
  });

  it('keeps both services in memory for ADK_DISABLE_LOCAL_STORAGE', async () => {
    process.env['ADK_DISABLE_LOCAL_STORAGE'] = '1';

    await parse(['web', agentsDir]);

    expect(serverOptions().sessionService).toBeInstanceOf(
      InMemorySessionService,
    );
    expect(serverOptions().artifactService).toBeInstanceOf(
      InMemoryArtifactService,
    );
    expect(await fs.readdir(agentsDir)).toEqual([]);
  });

  it('keeps DATABASE_URL ahead of local session storage', async () => {
    process.env['DATABASE_URL'] = 'sqlite://:memory:';

    await parse(['web', agentsDir]);

    expect(serverOptions().sessionService).toBeInstanceOf(
      DatabaseSessionService,
    );
    expect(serverOptions().artifactService).toBeInstanceOf(
      PerAgentFileArtifactService,
    );
  });
});
