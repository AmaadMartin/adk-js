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

const SCRIPT_PATH = fileURLToPath(
  new URL('../../../scripts/check_production_install.mjs', import.meta.url),
);

/** Fixture root for the test currently running. */
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-production-install-'));
});

afterEach(() => {
  fs.rmSync(root, {recursive: true, force: true});
});

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function writeRootManifest(workspaces: string[]): void {
  writeJson(path.join(root, 'package.json'), {name: 'fixture', workspaces});
}

function writeWorkspaceManifest(
  workspace: string,
  manifest: Record<string, unknown>,
): void {
  writeJson(path.join(root, workspace, 'package.json'), {
    name: workspace,
    ...manifest,
  });
}

/** Creates `<dir>/node_modules/<name>` as an installed package directory. */
function installPackage(dir: string, name: string): void {
  fs.mkdirSync(path.join(root, dir, 'node_modules', name), {recursive: true});
}

function runCheck(
  args: string[] = [root],
  cwd?: string,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
    cwd,
  });
}

describe('check_production_install', () => {
  it('passes when a declared dependency is hoisted to the root', () => {
    writeRootManifest(['alpha']);
    writeWorkspaceManifest('alpha', {dependencies: {'dep-one': '^1.0.0'}});
    installPackage('.', 'dep-one');

    const result = runCheck();

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Verified 1 production dependencies');
    expect(result.stdout).toContain('across 1 workspaces');
  });

  it('defaults the root directory to the working directory', () => {
    writeRootManifest(['alpha']);
    writeWorkspaceManifest('alpha', {dependencies: {'dep-one': '^1.0.0'}});
    installPackage('.', 'dep-one');

    const result = runCheck([], root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Verified 1 production dependencies');
  });

  it('fails and names both probed paths when a dependency is absent', () => {
    writeRootManifest(['alpha']);
    writeWorkspaceManifest('alpha', {dependencies: {'dep-one': '^1.0.0'}});

    const result = runCheck();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('alpha');
    expect(result.stderr).toContain('dep-one');
    expect(result.stderr).toContain(
      path.join(root, 'alpha', 'node_modules', 'dep-one'),
    );
    expect(result.stderr).toContain(path.join(root, 'node_modules', 'dep-one'));
    expect(result.stderr).toContain('::error::');
  });

  it('passes when a dependency is nested under the workspace', () => {
    writeRootManifest(['alpha']);
    writeWorkspaceManifest('alpha', {dependencies: {'dep-one': '^1.0.0'}});
    installPackage('alpha', 'dep-one');

    const result = runCheck();

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('resolves a scoped dependency name', () => {
    writeRootManifest(['alpha']);
    writeWorkspaceManifest('alpha', {dependencies: {'@scope/pkg': '^1.0.0'}});
    installPackage('.', '@scope/pkg');

    const result = runCheck();

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('follows a symlinked package directory', () => {
    writeRootManifest(['alpha']);
    writeWorkspaceManifest('alpha', {dependencies: {'@scope/pkg': '^1.0.0'}});
    const linkTarget = path.join(root, 'vendor', 'pkg');
    fs.mkdirSync(linkTarget, {recursive: true});
    const link = path.join(root, 'node_modules', '@scope', 'pkg');
    fs.mkdirSync(path.dirname(link), {recursive: true});
    fs.symlinkSync(linkTarget, link, 'junction');

    const result = runCheck();

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('fails when the installed path is a file rather than a directory', () => {
    writeRootManifest(['alpha']);
    writeWorkspaceManifest('alpha', {dependencies: {'dep-one': '^1.0.0'}});
    const installed = path.join(root, 'node_modules', 'dep-one');
    fs.mkdirSync(path.dirname(installed), {recursive: true});
    fs.writeFileSync(installed, '');

    const result = runCheck();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dep-one');
  });

  it('ignores devDependencies', () => {
    writeRootManifest(['alpha']);
    writeWorkspaceManifest('alpha', {
      dependencies: {'dep-one': '^1.0.0'},
      devDependencies: {'dev-only': '^1.0.0'},
    });
    installPackage('.', 'dep-one');

    const result = runCheck();

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Verified 1 production dependencies');
  });

  it('reports every unresolved dependency in a single run', () => {
    writeRootManifest(['alpha', 'beta']);
    writeWorkspaceManifest('alpha', {dependencies: {'dep-one': '^1.0.0'}});
    writeWorkspaceManifest('beta', {dependencies: {'dep-two': '^1.0.0'}});

    const result = runCheck();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dep-one');
    expect(result.stderr).toContain('dep-two');
    expect(result.stderr).toContain('2 of 2 declared production dependencies');
  });

  describe('inputs it cannot verify', () => {
    it('rejects a glob workspace entry instead of skipping it', () => {
      writeRootManifest(['packages/*']);

      const result = runCheck();

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Unsupported glob');
      expect(result.stderr).toContain('packages/*');
    });

    it('fails when the root manifest is missing', () => {
      const result = runCheck();

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `Cannot read ${path.join(root, 'package.json')}`,
      );
    });

    it('fails when the root manifest declares no workspaces array', () => {
      writeJson(path.join(root, 'package.json'), {name: 'fixture'});

      const result = runCheck();

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('no "workspaces" array');
    });

    it('fails when a workspace manifest is missing', () => {
      writeRootManifest(['alpha']);

      const result = runCheck();

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `Cannot read ${path.join(root, 'alpha', 'package.json')}`,
      );
    });

    it('fails when a workspace manifest is not valid JSON', () => {
      writeRootManifest(['alpha']);
      const manifestPath = path.join(root, 'alpha', 'package.json');
      fs.mkdirSync(path.dirname(manifestPath), {recursive: true});
      fs.writeFileSync(manifestPath, '{');

      const result = runCheck();

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Cannot parse ${manifestPath}`);
    });
  });
});
