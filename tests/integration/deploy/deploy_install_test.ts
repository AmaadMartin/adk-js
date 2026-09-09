/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {exec} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {promisify} from 'node:util';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {stageDependencyFiles} from '../../../dev/src/cli/deploy/deploy_utils.js';

const execAsync = promisify(exec);

describe('Deploy dependency staging', () => {
  let root: string;
  let projectDir: string;
  let stagingDir: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-deploy-install-'));
    // Siblings, so `file:../stub` resolves the same way from the project and
    // from the staging folder.
    const stubDir = path.join(root, 'stub');
    projectDir = path.join(root, 'project');
    stagingDir = path.join(root, 'staging');
    await Promise.all([
      fs.mkdir(stubDir),
      fs.mkdir(projectDir),
      fs.mkdir(stagingDir),
    ]);

    await fs.writeFile(
      path.join(stubDir, 'package.json'),
      JSON.stringify({name: '@google/adk', version: '1.0.0'}),
    );
    await fs.writeFile(
      path.join(projectDir, 'package.json'),
      JSON.stringify({
        name: 'proj',
        version: '1.0.0',
        // Stands in for a project script that only works in the developer's
        // checkout: `npm ci` runs `prepare`, so staging it would break the
        // image build.
        scripts: {prepare: 'exit 7'},
        dependencies: {'@google/adk': 'file:../stub'},
      }),
    );
    await execAsync('npm install --ignore-scripts --no-audit --no-fund', {
      cwd: projectDir,
    });
  });

  afterAll(async () => {
    await fs.rm(root, {recursive: true, force: true});
  });

  it('installs the staged files with npm ci', async () => {
    const staged = await stageDependencyFiles(projectDir, stagingDir);

    expect(staged).toBe(true);
    await expect(
      fs.readFile(path.join(stagingDir, 'package-lock.json'), 'utf8'),
    ).resolves.toEqual(
      await fs.readFile(path.join(projectDir, 'package-lock.json'), 'utf8'),
    );
    expect(
      JSON.parse(
        await fs.readFile(path.join(stagingDir, 'package.json'), 'utf8'),
      ),
    ).toEqual({dependencies: {'@google/adk': 'file:../stub'}});

    // Also proves the project's `prepare: exit 7` was not staged: npm ci
    // runs the root package's prepare script and would fail here.
    await execAsync('npm ci --omit=dev --no-audit --no-fund', {
      cwd: stagingDir,
    });

    const installed = JSON.parse(
      await fs.readFile(
        path.join(stagingDir, 'node_modules', '@google', 'adk', 'package.json'),
        'utf8',
      ),
    );
    expect(installed).toMatchObject({name: '@google/adk', version: '1.0.0'});
  });

  it('stages no lock file when the project has none', async () => {
    const noLockProject = path.join(root, 'no-lock-project');
    const noLockStaging = path.join(root, 'no-lock-staging');
    await Promise.all([fs.mkdir(noLockProject), fs.mkdir(noLockStaging)]);
    await fs.writeFile(
      path.join(noLockProject, 'package.json'),
      JSON.stringify({
        name: 'no-lock',
        version: '1.0.0',
        dependencies: {'@google/adk': 'file:../stub'},
      }),
    );

    const staged = await stageDependencyFiles(noLockProject, noLockStaging);

    expect(staged).toBe(false);
    await expect(
      fs.access(path.join(noLockStaging, 'package-lock.json')),
    ).rejects.toThrow();
  });
});
