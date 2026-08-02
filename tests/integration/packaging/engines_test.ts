/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import yaml from 'js-yaml';
import {readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

/**
 * The Node.js support floor published to consumers. The three packages are
 * versioned in lockstep and installed together, so they must all advertise
 * exactly this range rather than three different floors.
 */
const SUPPORTED_NODE_MAJOR = 20;
const SUPPORTED_NODE_RANGE = `>=${SUPPORTED_NODE_MAJOR}`;

/** Workspaces whose manifests are published to npm. */
const PUBLISHED_WORKSPACES = ['core', 'dev', 'integrations'];

/** The repository's single source of truth for the toolchain Node version. */
const NODE_VERSION_FILE = '.nvmrc';

const WORKFLOWS_DIR = '.github/workflows';

const repoRoot = process.cwd();

interface Manifest {
  engines?: {node?: string};
}

interface WorkflowStep {
  uses?: string;
  with?: {'node-version-file'?: string};
}

interface Workflow {
  jobs?: Record<string, {steps?: WorkflowStep[]}>;
}

function readManifest(workspace: string): Manifest {
  const manifestPath = path.join(repoRoot, workspace, 'package.json');
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
}

function readWorkflowFilenames(): string[] {
  return readdirSync(path.join(repoRoot, WORKFLOWS_DIR)).filter((name) =>
    /\.ya?ml$/.test(name),
  );
}

function readSetupNodeSteps(filename: string): WorkflowStep[] {
  const contents = readFileSync(
    path.join(repoRoot, WORKFLOWS_DIR, filename),
    'utf8',
  );
  const workflow = yaml.load(contents) as Workflow;
  return Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .filter((step) => step.uses?.startsWith('actions/setup-node@'));
}

describe('published package manifests', () => {
  it.each(PUBLISHED_WORKSPACES)(
    '%s declares the supported Node.js engine range',
    (workspace) => {
      expect(readManifest(workspace).engines?.node).toBe(SUPPORTED_NODE_RANGE);
    },
  );
});

describe('toolchain Node version pin', () => {
  it('pins a .nvmrc version that satisfies the published range', () => {
    const pinned = readFileSync(
      path.join(repoRoot, NODE_VERSION_FILE),
      'utf8',
    ).trim();
    expect(pinned).toMatch(/^\d+$/);
    expect(Number(pinned)).toBeGreaterThanOrEqual(SUPPORTED_NODE_MAJOR);
  });

  it('resolves every setup-node step from .nvmrc', () => {
    let setupNodeStepCount = 0;
    for (const filename of readWorkflowFilenames()) {
      for (const step of readSetupNodeSteps(filename)) {
        setupNodeStepCount++;
        expect(
          step.with?.['node-version-file'],
          `${filename} must resolve Node from ${NODE_VERSION_FILE}`,
        ).toBe(NODE_VERSION_FILE);
      }
    }
    expect(setupNodeStepCount).toBeGreaterThan(0);
  });
});
