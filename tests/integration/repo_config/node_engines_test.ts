/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import yaml from 'js-yaml';
import {readFileSync, readdirSync} from 'node:fs';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

/**
 * Node.js LTS majors the project supports, oldest first. The first entry is the
 * declared floor; raise it when that line reaches end of life.
 */
const SUPPORTED_NODE_MAJORS = ['22', '24'];

/** The `engines.node` range every published manifest must declare. */
const ENGINES_NODE_RANGE = `>=${SUPPORTED_NODE_MAJORS[0]}.0.0`;

interface Manifest {
  workspaces?: string[];
  engines?: {node?: string};
}

interface WorkflowStep {
  uses?: string;
  with?: Record<string, string>;
}

interface WorkflowJob {
  strategy?: {matrix?: Record<string, string[]>};
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

/** A `setup-node` step paired with a human-readable location for failures. */
interface LocatedStep {
  label: string;
  step: WorkflowStep;
}

const repoRoot = process.cwd();
const WORKFLOW_DIR = path.join(repoRoot, '.github', 'workflows');

function readManifest(dir: string): Manifest {
  return JSON.parse(
    readFileSync(path.join(repoRoot, dir, 'package.json'), 'utf8'),
  ) as Manifest;
}

function readWorkflow(file: string): Workflow {
  return yaml.load(
    readFileSync(path.join(WORKFLOW_DIR, file), 'utf8'),
  ) as Workflow;
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR).filter(
    (f) => f.endsWith('.yml') || f.endsWith('.yaml'),
  );
}

/** Strips a leading range operator or `v` and returns the major version. */
function majorOf(version: string): number {
  return Number.parseInt(version.replace(/^[^\d]*/, ''), 10);
}

function setupNodeSteps(): LocatedStep[] {
  const steps: LocatedStep[] = [];
  for (const file of workflowFiles()) {
    const jobs = readWorkflow(file).jobs ?? {};
    for (const [jobName, job] of Object.entries(jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith('actions/setup-node')) {
          steps.push({label: `${file} job ${jobName}`, step});
        }
      }
    }
  }
  return steps;
}

describe('Node.js engines declaration', () => {
  it('declares the same engines.node in the root and every workspace', () => {
    const root = readManifest('.');
    const workspaces = root.workspaces ?? [];
    expect(workspaces.length).toBeGreaterThan(0);

    for (const dir of ['.', ...workspaces]) {
      expect(
        readManifest(dir).engines?.node,
        `${dir}/package.json engines.node`,
      ).toBe(ENGINES_NODE_RANGE);
    }
  });

  it('runs on a Node version that satisfies the declared floor', () => {
    expect(majorOf(process.versions.node)).toBeGreaterThanOrEqual(
      majorOf(ENGINES_NODE_RANGE),
    );
  });
});

describe('CI Node.js pinning', () => {
  it('pins an explicit node-version in every setup-node step', () => {
    const steps = setupNodeSteps();
    expect(steps.length).toBeGreaterThan(0);

    for (const {label, step} of steps) {
      expect(
        step.with?.['node-version'],
        `${label}: setup-node must pin node-version`,
      ).toBeTruthy();
    }
  });

  it('never pins a workflow below the declared floor', () => {
    const floor = majorOf(ENGINES_NODE_RANGE);
    for (const {label, step} of setupNodeSteps()) {
      const version = step.with?.['node-version'];
      // Matrix references are covered by the matrix assertion below.
      if (!version || version.includes('${{')) continue;
      expect(
        majorOf(version),
        `${label}: node-version ${version}`,
      ).toBeGreaterThanOrEqual(floor);
    }
  });

  it('exercises every supported LTS line in the validation matrix', () => {
    const job = readWorkflow('validation.yaml').jobs?.['run-tests'];
    expect(job?.strategy?.matrix?.['node']).toEqual(SUPPORTED_NODE_MAJORS);
  });
});
