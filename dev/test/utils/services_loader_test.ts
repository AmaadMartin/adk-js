/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getServiceRegistry} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {compileFile} from '../../src/utils/agent_loader.js';
import {AdkLogger} from '../../src/utils/logger.js';
import {loadServicesModule} from '../../src/utils/services_loader.js';

const compiledTempDirs = vi.hoisted(() => [] as string[]);

// The real compile still runs; the spy only records the temp directory it made,
// so a test can assert that directory is gone afterwards.
vi.mock('../../src/utils/agent_loader.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/utils/agent_loader.js')>();

  return {
    ...original,
    compileFile: vi.fn(async (filePath: string, options) => {
      const compiled = await original.compileFile(filePath, options);
      compiledTempDirs.push(compiled.tempDirPath);

      return compiled;
    }),
  };
});

const registry = getServiceRegistry();

let dir: string;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk_services_loader_test_'));
  compiledTempDirs.length = 0;
  vi.mocked(compileFile).mockClear();
  warn = vi.spyOn(AdkLogger.prototype, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, {recursive: true, force: true});
});

/** Writes a `services` module into the temp directory. */
async function writeServices(fileName: string, body: string): Promise<void> {
  await fs.writeFile(path.join(dir, fileName), body, 'utf8');
}

async function exists(dirPath: string): Promise<boolean> {
  try {
    await fs.stat(dirPath);

    return true;
  } catch {
    return false;
  }
}

describe('loadServicesModule', () => {
  it('registers a session factory from services.js', async () => {
    await writeServices(
      'services.js',
      `export const services = {
         session: {mysession: (uri) => ({kind: 'session', uri})},
       };`,
    );

    await loadServicesModule(dir);

    expect(registry.createSessionService('mysession://x')).toEqual({
      kind: 'session',
      uri: 'mysession://x',
    });
  });

  it('registers an artifact factory from services.ts', async () => {
    await writeServices(
      'services.ts',
      `interface Built {kind: string; uri: string}
       export const services = {
         artifact: {
           myartifact: (uri: string): Built => ({kind: 'artifact', uri}),
         },
       };`,
    );

    await loadServicesModule(dir);

    expect(registry.createArtifactService('myartifact://x')).toEqual({
      kind: 'artifact',
      uri: 'myartifact://x',
    });
  });

  it('reads the default export when there is no named services export', async () => {
    await writeServices(
      'services.js',
      `export default {
         memory: {mydefaultmemory: (uri) => ({kind: 'memory', uri})},
       };`,
    );

    await loadServicesModule(dir);

    expect(registry.createMemoryService('mydefaultmemory://x')).toEqual({
      kind: 'memory',
      uri: 'mydefaultmemory://x',
    });
  });

  it('forwards the factory options to a registered factory', async () => {
    await writeServices(
      'services.js',
      `export const services = {
         session: {myoptions: (uri, options) => ({uri, options})},
       };`,
    );

    await loadServicesModule(dir);

    expect(
      registry.createSessionService('myoptions://x', {agentsDir: '/agents'}),
    ).toEqual({uri: 'myoptions://x', options: {agentsDir: '/agents'}});
  });

  it('loads the services module beside an agent file', async () => {
    await writeServices(
      'services.js',
      `export const services = {
         session: {mysibling: (uri) => ({uri})},
       };`,
    );
    const agentFile = path.join(dir, 'agent.js');
    await fs.writeFile(agentFile, 'export const rootAgent = {};', 'utf8');

    await loadServicesModule(agentFile);

    expect(registry.createSessionService('mysibling://x')).toEqual({
      uri: 'mysibling://x',
    });
  });

  it('prefers .js over .ts when both are present', async () => {
    await writeServices(
      'services.js',
      `export const services = {
         session: {myprecedence: () => ({from: 'js'})},
       };`,
    );
    await writeServices(
      'services.ts',
      `export const services = {
         session: {myprecedence: () => ({from: 'ts'})},
       };`,
    );

    await loadServicesModule(dir);

    expect(registry.createSessionService('myprecedence://x')).toEqual({
      from: 'js',
    });
  });

  it('registers nothing and does not throw without a services module', async () => {
    await expect(loadServicesModule(dir)).resolves.toBeUndefined();

    expect(registry.createSessionService('mymissing://x')).toBeUndefined();
    expect(compileFile).not.toHaveBeenCalled();
  });

  it('registers nothing and does not throw for a missing directory', async () => {
    await expect(
      loadServicesModule(path.join(dir, 'absent')),
    ).resolves.toBeUndefined();

    expect(compileFile).not.toHaveBeenCalled();
  });

  it('warns instead of throwing when the module throws at import time', async () => {
    await writeServices(
      'services.js',
      `throw new Error('boom from the user module');`,
    );

    await expect(loadServicesModule(dir)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('boom from the user module'),
    );
  });

  it('warns when the module throws something that is not an Error', async () => {
    await writeServices('services.js', `throw 'a bare string, not an Error';`);

    await expect(loadServicesModule(dir)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('a bare string, not an Error'),
    );
  });

  it('warns when the module exports no registrations object', async () => {
    await writeServices('services.js', `export const unrelated = 1;`);

    await loadServicesModule(dir);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exports no'));
  });

  it('skips an entry that is not a function and keeps its valid sibling', async () => {
    await writeServices(
      'services.js',
      `export const services = {
         session: {
           mybroken: 'not-a-function',
           myvalid: (uri) => ({uri}),
         },
       };`,
    );

    await loadServicesModule(dir);

    expect(registry.createSessionService('mybroken://x')).toBeUndefined();
    expect(registry.createSessionService('myvalid://x')).toEqual({
      uri: 'myvalid://x',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Invalid session service registration for 'mybroken'",
      ),
    );
  });

  it('names the service kind of an invalid artifact and memory entry', async () => {
    await writeServices(
      'services.js',
      `export const services = {
         artifact: {mybadartifact: 1},
         memory: {mybadmemory: null},
       };`,
    );

    await loadServicesModule(dir);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Invalid artifact service registration for 'mybadartifact'",
      ),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Invalid memory service registration for 'mybadmemory'",
      ),
    );
  });

  it('removes the compile temp directory afterwards', async () => {
    await writeServices(
      'services.ts',
      `export const services = {session: {mytempdir: () => ({})}};`,
    );

    await loadServicesModule(dir);

    expect(compiledTempDirs).toHaveLength(1);
    expect(await exists(compiledTempDirs[0])).toBe(false);
  });

  it('removes the compile temp directory when the import fails', async () => {
    await writeServices('services.ts', `throw new Error('boom');`);

    await loadServicesModule(dir);

    expect(compiledTempDirs).toHaveLength(1);
    expect(await exists(compiledTempDirs[0])).toBe(false);
  });

  it('imports the module directly when compiling is disabled', async () => {
    await writeServices(
      'services.mjs',
      `export const services = {session: {mynocompile: (uri) => ({uri})}};`,
    );

    await loadServicesModule(dir, {compile: false, bundle: false});

    expect(registry.createSessionService('mynocompile://x')).toEqual({
      uri: 'mynocompile://x',
    });
    expect(compileFile).not.toHaveBeenCalled();
  });

  it('registers all three service kinds from one module', async () => {
    await writeServices(
      'services.js',
      `export const services = {
         session: {myall: () => ({kind: 'session'})},
         artifact: {myall: () => ({kind: 'artifact'})},
         memory: {myall: () => ({kind: 'memory'})},
       };`,
    );

    await loadServicesModule(dir);

    expect(registry.createSessionService('myall://x')).toEqual({
      kind: 'session',
    });
    expect(registry.createArtifactService('myall://x')).toEqual({
      kind: 'artifact',
    });
    expect(registry.createMemoryService('myall://x')).toEqual({
      kind: 'memory',
    });
  });
});
