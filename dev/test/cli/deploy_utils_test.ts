/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Dependency resolution for `adk deploy`, driven against the real filesystem.
 *
 * The logic under test is a walk over `package.json` files, so mocking
 * `node:fs/promises` or `file_utils` here would only test the mock. Each case
 * builds its layout under a private temp directory and asserts on the manifest
 * actually written into the staging folder.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';

import {createPackageJson} from '../../src/cli/deploy/deploy_utils.js';

interface Manifest {
  name?: string;
  dependencies?: unknown;
  workspaces?: string[];
}

describe('createPackageJson', () => {
  let root = '';
  let target = '';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'adk_deploy_utils_test-'));
    target = path.join(root, 'staging');
    await fs.mkdir(target);
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, {recursive: true, force: true});
  });

  /** Creates `<root>/<relativeDir>` and writes `manifest` into it. */
  async function writeManifest(
    relativeDir: string,
    manifest: Manifest | string,
  ): Promise<string> {
    const dir = path.join(root, relativeDir);
    await fs.mkdir(dir, {recursive: true});
    const manifestPath = path.join(dir, 'package.json');
    await fs.writeFile(
      manifestPath,
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
      'utf-8',
    );

    return manifestPath;
  }

  /** Creates `<root>/<relativeDir>` and returns its absolute path. */
  async function makeAgentDir(relativeDir: string): Promise<string> {
    const dir = path.join(root, relativeDir);
    await fs.mkdir(dir, {recursive: true});

    return dir;
  }

  /** Runs `createPackageJson` and returns the error it rejects with. */
  async function captureFailure(agentDir: string): Promise<Error> {
    const error = await createPackageJson(agentDir, target).then(
      () => undefined,
      (e: unknown) => e,
    );
    if (!(error instanceof Error)) {
      expect.fail('createPackageJson resolved instead of reporting a failure');
    }

    return error;
  }

  async function readGeneratedDependencies(): Promise<
    Record<string, string> | undefined
  > {
    const generated = JSON.parse(
      await fs.readFile(path.join(target, 'package.json'), 'utf-8'),
    ) as {dependencies?: Record<string, string>};

    return generated.dependencies;
  }

  it('keeps a single-package project resolving from its only manifest', async () => {
    await writeManifest('.', {
      dependencies: {'@google/adk': '^1.6.0', zod: '^4.0.0'},
    });
    const agentDir = await makeAgentDir('agent');

    await createPackageJson(agentDir, target);

    expect(await readGeneratedDependencies()).toEqual({
      '@google/adk': '^1.6.0',
      zod: '^4.0.0',
    });
    expect(
      (await fs.stat(path.join(target, 'node_modules'))).isDirectory(),
    ).toBe(true);
    expect(
      await fs.readFile(path.join(target, 'package-lock.json'), 'utf-8'),
    ).toBe('');
  });

  it('keeps the sub-package version when the workspace root declares another', async () => {
    await writeManifest('.', {
      workspaces: ['packages/*'],
      dependencies: {'@google/adk': '^1.0.0'},
    });
    await writeManifest('packages/my-agent', {
      name: 'my-agent',
      dependencies: {'@google/adk': '^2.0.0'},
    });
    const agentDir = await makeAgentDir('packages/my-agent/src');

    await createPackageJson(agentDir, target);

    expect(await readGeneratedDependencies()).toEqual({
      '@google/adk': '^2.0.0',
    });
  });

  it('backfills only the required packages from the workspace root', async () => {
    const rootManifest = await writeManifest('.', {
      workspaces: ['packages/*'],
      dependencies: {'@google/adk': '^1.6.0', 'left-pad': '^1.3.0'},
    });
    await writeManifest('packages/my-agent', {
      name: 'my-agent',
      dependencies: {zod: '^4.0.0'},
    });
    const agentDir = await makeAgentDir('packages/my-agent/src');

    await createPackageJson(agentDir, target);

    expect(await readGeneratedDependencies()).toEqual({
      zod: '^4.0.0',
      '@google/adk': '^1.6.0',
    });
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('"@google/adk"'),
      rootManifest,
    );
  });

  it('resolves a sub-package manifest that declares no dependencies', async () => {
    await writeManifest('.', {
      workspaces: ['packages/*'],
      dependencies: {'@google/adk': '^1.6.0'},
    });
    await writeManifest('packages/my-agent', {name: 'my-agent'});
    const agentDir = await makeAgentDir('packages/my-agent/src');

    await createPackageJson(agentDir, target);

    expect(await readGeneratedDependencies()).toEqual({
      '@google/adk': '^1.6.0',
    });
  });

  it('resolves a sub-package manifest whose dependencies are not an object', async () => {
    await writeManifest('.', {
      workspaces: ['packages/*'],
      dependencies: {'@google/adk': '^1.6.0'},
    });
    await writeManifest('packages/my-agent', {
      name: 'my-agent',
      dependencies: 'not-an-object',
    });
    const agentDir = await makeAgentDir('packages/my-agent/src');

    await createPackageJson(agentDir, target);

    expect(await readGeneratedDependencies()).toEqual({
      '@google/adk': '^1.6.0',
    });
  });

  it('finds a manifest five levels above the agent', async () => {
    await writeManifest('.', {dependencies: {'@google/adk': '^1.6.0'}});
    const agentDir = await makeAgentDir('packages/agent/src/agents/nested');

    await createPackageJson(agentDir, target);

    expect(await readGeneratedDependencies()).toEqual({
      '@google/adk': '^1.6.0',
    });
  });

  it('names both manifests when neither declares the required package', async () => {
    const rootManifest = await writeManifest('.', {
      workspaces: ['packages/*'],
      dependencies: {'left-pad': '^1.3.0'},
    });
    const subManifest = await writeManifest('packages/my-agent', {
      name: 'my-agent',
      dependencies: {zod: '^4.0.0'},
    });
    const agentDir = await makeAgentDir('packages/my-agent/src');

    const error = await captureFailure(agentDir);

    expect(error.message).toContain('"@google/adk"');
    expect(error.message).toContain(subManifest);
    expect(error.message).toContain(rootManifest);
    await expect(
      fs.access(path.join(target, 'package.json')),
    ).rejects.toThrow();
  });

  it('reports that no workspace root was found above the agent', async () => {
    const soleManifest = await writeManifest('.', {
      dependencies: {zod: '^4.0.0'},
    });
    const agentDir = await makeAgentDir('agent');

    const error = await captureFailure(agentDir);

    expect(error.message).toContain(soleManifest);
    expect(error.message).toContain(
      'no ancestor manifest declaring "workspaces" was found within 10 levels',
    );
  });

  it('ignores an ancestor manifest that declares no workspaces', async () => {
    await writeManifest('.', {dependencies: {'@google/adk': '^1.6.0'}});
    await writeManifest('packages/my-agent', {name: 'my-agent'});
    const agentDir = await makeAgentDir('packages/my-agent/src');

    const error = await captureFailure(agentDir);

    expect(error.message).toContain('"@google/adk"');
  });

  it('skips an unparseable manifest between the agent and the workspace root', async () => {
    await writeManifest('.', {
      workspaces: ['packages/*'],
      dependencies: {'@google/adk': '^1.6.0'},
    });
    await writeManifest('packages', '{ not json');
    await writeManifest('packages/my-agent', {name: 'my-agent'});
    const agentDir = await makeAgentDir('packages/my-agent/src');

    await createPackageJson(agentDir, target);

    expect(await readGeneratedDependencies()).toEqual({
      '@google/adk': '^1.6.0',
    });
  });

  it('writes into a staging folder that already contains node_modules', async () => {
    await writeManifest('.', {dependencies: {'@google/adk': '^1.6.0'}});
    const agentDir = await makeAgentDir('agent');
    await fs.mkdir(path.join(target, 'node_modules'));

    await createPackageJson(agentDir, target);

    expect(await readGeneratedDependencies()).toEqual({
      '@google/adk': '^1.6.0',
    });
  });

  describe('workspace-local specifiers', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    /**
     * Writes a manifest declaring `@google/adk` plus `dependencies`, then
     * stages it and returns the dependencies of the generated manifest.
     */
    async function generateFrom(
      dependencies: Record<string, string>,
    ): Promise<Record<string, string> | undefined> {
      await writeManifest('.', {
        dependencies: {'@google/adk': '^1.6.0', ...dependencies},
      });
      const agentDir = await makeAgentDir('agent');

      await createPackageJson(agentDir, target);

      return readGeneratedDependencies();
    }

    it.each([
      'workspace:*',
      'file:../shared',
      'link:../shared',
      'portal:../shared',
      'catalog:default',
    ])('omits a dependency declared as %s', async (specifier) => {
      expect(await generateFrom({'@myco/shared': specifier})).toEqual({
        '@google/adk': '^1.6.0',
      });
    });

    it('omits dependencies declared as bare local paths', async () => {
      expect(
        await generateFrom({
          a: '../shared',
          b: './shared',
          c: '/opt/shared',
          d: '~/shared',
          e: '..\\shared',
        }),
      ).toEqual({'@google/adk': '^1.6.0'});
    });

    it('keeps every specifier npm can install without a workspace', async () => {
      const installable = {
        x: '^1.0.0',
        y: 'latest',
        z: 'npm:other@^1.0.0',
        g: 'github:owner/repo',
        h: 'git+https://example.com/r.git',
        t: 'https://example.com/p.tgz',
      };

      expect(await generateFrom(installable)).toEqual({
        '@google/adk': '^1.6.0',
        ...installable,
      });
    });

    it('matches the specifier, not the dependency name', async () => {
      const namedLikeProtocols = {
        'link-checker': '^1.0.0',
        'workspace-tools': '~2.0.0',
        'file-type': '1.2.3',
      };

      expect(await generateFrom(namedLikeProtocols)).toEqual({
        '@google/adk': '^1.6.0',
        ...namedLikeProtocols,
      });
    });

    it('warns once, naming every omitted dependency and its specifier', async () => {
      await generateFrom({
        '@myco/shared': 'workspace:*',
        utils: 'file:../utils',
      });

      expect(console.warn).toHaveBeenCalledTimes(1);
      const warning = String((console.warn as Mock).mock.calls[0][0]);
      expect(warning).toContain('"@myco/shared" ("workspace:*")');
      expect(warning).toContain('"utils" ("file:../utils")');
      expect(warning).toContain('--bundle false');
    });

    it('stays silent when every dependency is installable', async () => {
      expect(await generateFrom({zod: '^4.0.0'})).toEqual({
        '@google/adk': '^1.6.0',
        zod: '^4.0.0',
      });
      expect(console.warn).not.toHaveBeenCalled();
    });

    it.each(['workspace:*', 'file:../adk'])(
      'rejects a required package declared as %s',
      async (specifier) => {
        const manifest = await writeManifest('.', {
          dependencies: {'@google/adk': specifier},
        });
        const agentDir = await makeAgentDir('agent');

        const error = await captureFailure(agentDir);

        expect(error.message).toContain(`"@google/adk" ("${specifier}")`);
        expect(error.message).toContain(manifest);
        await expect(
          fs.access(path.join(target, 'package.json')),
        ).rejects.toThrow();
      },
    );

    it('names the workspace root when the backfilled required package is local', async () => {
      const rootManifest = await writeManifest('.', {
        workspaces: ['packages/*'],
        dependencies: {'@google/adk': 'workspace:*'},
      });
      await writeManifest('packages/my-agent', {name: 'my-agent'});
      const agentDir = await makeAgentDir('packages/my-agent/src');

      const error = await captureFailure(agentDir);

      expect(error.message).toContain('"@google/adk" ("workspace:*")');
      expect(error.message).toContain(rootManifest);
    });
  });
});
