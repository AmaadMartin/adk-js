/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import yaml from 'js-yaml';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

const WORKFLOWS_DIR = path.join(process.cwd(), '.github/workflows');

/** Activity types GitHub uses when a `pull_request` trigger omits `types`. */
const DEFAULT_PULL_REQUEST_TYPES = ['opened', 'synchronize', 'reopened'];

/** The subset of a workflow file this test inspects. */
interface Workflow {
  on?: {pull_request?: {types?: string[]} | null};
  concurrency?: {group?: string; 'cancel-in-progress'?: boolean};
}

function isWorkflow(value: unknown): value is Workflow {
  return typeof value === 'object' && value !== null;
}

function loadWorkflow(file: string): Workflow {
  const source = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');
  const parsed: unknown = yaml.load(source);
  return isWorkflow(parsed) ? parsed : {};
}

/**
 * A workflow can be superseded only if a later push to the same pull request
 * re-triggers it, i.e. if its `pull_request` activity types include
 * `synchronize`.
 */
function isSupersedable(workflow: Workflow): boolean {
  const pullRequest = workflow.on?.pull_request;
  if (pullRequest === undefined) {
    return false;
  }
  const types = pullRequest?.types ?? DEFAULT_PULL_REQUEST_TYPES;
  return types.includes('synchronize');
}

const workflows = fs
  .readdirSync(WORKFLOWS_DIR)
  .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
  .map((file): [string, Workflow] => [file, loadWorkflow(file)]);

const supersedable = workflows.filter(([, workflow]) =>
  isSupersedable(workflow),
);

describe('Workflow concurrency', () => {
  it('discovers at least one supersedable workflow', () => {
    for (const [file, workflow] of workflows) {
      // js-yaml keeps `on` a string key (YAML 1.2); a missing trigger block
      // would make every assertion below vacuous.
      expect(
        workflow.on,
        `${file} declares no 'on' trigger block`,
      ).toBeDefined();
    }

    expect(supersedable.length).toBeGreaterThan(0);
  });

  it.each(supersedable)(
    '%s cancels superseded pull request runs',
    (file, workflow) => {
      const concurrency = workflow.concurrency;
      expect(
        concurrency,
        `${file} declares no concurrency group`,
      ).toBeDefined();

      // The run-id fallback is what keeps runs on main out of a shared group.
      expect(concurrency?.group).toContain('github.event.pull_request.number');
      expect(concurrency?.group).toContain('github.run_id');
      expect(concurrency?.['cancel-in-progress']).toBe(true);
    },
  );

  it('release-please.yml never cancels an in-progress release run', () => {
    const {concurrency} = loadWorkflow('release-please.yml');

    expect(concurrency?.['cancel-in-progress'] ?? false).toBe(false);
  });
});
