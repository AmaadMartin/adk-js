/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Drives the real `run` and `api_server` actions to prove where the CLI takes
// its services from. Only the agent run and the HTTP server are replaced; the
// registry, the URI resolution and the fall-through to @google/adk core are
// the real ones.

import {InMemoryArtifactService, InMemorySessionService} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {createProgram} from '../../src/cli/cli.js';
import {runAgent, RunAgentOptions} from '../../src/cli/cli_run.js';
import {getServiceRegistry} from '../../src/cli/service_registry.js';
import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {createTempDir} from '../../src/utils/file_utils.js';
import {AdkLogger} from '../../src/utils/logger.js';

vi.mock('../../src/cli/cli_run', () => ({runAgent: vi.fn()}));
vi.mock('../../src/server/adk_api_server', () => ({
  AdkApiServer: vi.fn(() => ({start: vi.fn()})),
}));

/** A session service only the registry can produce, so its use is provable. */
class HookTestSessionService extends InMemorySessionService {}
class HookTestArtifactService extends InMemoryArtifactService {}

function lastRunOptions(): RunAgentOptions {
  const calls = vi.mocked(runAgent).mock.calls;
  const options = calls.at(-1)?.[0];
  if (!options) {
    expect.fail('runAgent was never called');
  }
  return options;
}

describe('CLI service registry hook', () => {
  let dir = '';
  let agentPath = '';

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await createTempDir('adk_cli_hook_test');
    agentPath = path.join(dir, 'agent.ts');
    await fs.writeFile(agentPath, 'export const rootAgent = undefined;\n');
  });

  afterEach(async () => {
    await fs.rm(dir, {recursive: true, force: true});
    vi.restoreAllMocks();
  });

  async function run(args: string[]): Promise<void> {
    const program = createProgram();
    program.exitOverride();
    await program.parseAsync(['node', 'cli_entrypoint.js', ...args]);
  }

  it('builds the session service from a registered scheme', async () => {
    getServiceRegistry().registerSessionService(
      'hooksession',
      () => new HookTestSessionService(),
    );

    await run(['run', agentPath, '--session_service_uri', 'hooksession://x']);

    expect(lastRunOptions().sessionService).toBeInstanceOf(
      HookTestSessionService,
    );
  });

  it('builds the artifact service from a registered scheme', async () => {
    getServiceRegistry().registerArtifactService(
      'hookartifact',
      () => new HookTestArtifactService(),
    );

    await run(['run', agentPath, '--artifact_service_uri', 'hookartifact://x']);

    expect(lastRunOptions().artifactService).toBeInstanceOf(
      HookTestArtifactService,
    );
  });

  it('falls through to the core resolver for an unregistered scheme', async () => {
    await run(['run', agentPath, '--session_service_uri', 'memory://']);

    const {sessionService, artifactService} = lastRunOptions();
    expect(sessionService).toBeInstanceOf(InMemorySessionService);
    expect(sessionService).not.toBeInstanceOf(HookTestSessionService);
    expect(artifactService).toBeInstanceOf(InMemoryArtifactService);
  });

  it('reports an unregistered scheme the core resolver rejects', async () => {
    const errors: string[] = [];
    vi.spyOn(AdkLogger.prototype, 'error').mockImplementation(
      (...parts: unknown[]) => {
        errors.push(parts.join(' '));
      },
    );
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await run(['run', agentPath, '--session_service_uri', 'nosuch://x']);

    expect(errors.join('\n')).toContain('Unsupported session service URI');
  });

  it('registers a scheme the agent directory declares before building it', async () => {
    await fs.writeFile(
      path.join(dir, 'services.js'),
      `import {getServiceRegistry} from ${JSON.stringify(
        new URL('../../src/cli/service_registry.ts', import.meta.url).pathname,
      )};
       getServiceRegistry().registerSessionService(
         'declaredbeside',
         (uri) => ({declaredFor: uri}),
       );`,
    );

    await run([
      'run',
      agentPath,
      '--session_service_uri',
      'declaredbeside://here',
    ]);

    expect(lastRunOptions().sessionService).toMatchObject({
      declaredFor: 'declaredbeside://here',
    });
  });

  it('loads the services of the agents directory for api_server', async () => {
    await fs.writeFile(
      path.join(dir, 'services.js'),
      `import {getServiceRegistry} from ${JSON.stringify(
        new URL('../../src/cli/service_registry.ts', import.meta.url).pathname,
      )};
       getServiceRegistry().registerSessionService(
         'apiserverscheme',
         () => ({fromApiServer: true}),
       );`,
    );

    await run([
      'api_server',
      dir,
      '--session_service_uri',
      'apiserverscheme://x',
    ]);

    const options = vi.mocked(AdkApiServer).mock.calls.at(-1)?.[0];
    expect(options?.sessionService).toMatchObject({fromApiServer: true});
  });
});
