/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import rootPackage from '../../../package.json' with {type: 'json'};

const WORKFLOWS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../.github/workflows',
);

/** A GitHub Actions workflow file: `<name>.yml` or `<name>.yaml`. */
const WORKFLOW_FILE_PATTERN = /\.ya?ml$/;

/** `npm run <script>` as it appears in a workflow `run:` step. */
const NPM_RUN_PATTERN = /\bnpm\s+run\s+([\w:@./-]+)/g;

/** `--project <name>` or `--project=<name>` in an npm script command. */
const PROJECT_FLAG_PATTERN = /--project[=\s]+([^\s"']+)/g;

/** A command that runs vitest, rather than another tool taking `--project`. */
const VITEST_COMMAND_PATTERN = /\bvitest\b/;

/** Raw text of every workflow file. Throws if the directory is missing. */
async function readWorkflowFiles(): Promise<string[]> {
  const entries = await fs.readdir(WORKFLOWS_DIR);
  return Promise.all(
    entries
      .filter((entry) => WORKFLOW_FILE_PATTERN.test(entry))
      .map((entry) => fs.readFile(path.join(WORKFLOWS_DIR, entry), 'utf-8')),
  );
}

/** Drops whole-line `#` comments so a commented-out step reads as absent. */
function stripCommentLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

function extractNpmRunScripts(text: string): string[] {
  return [...stripCommentLines(text).matchAll(NPM_RUN_PATTERN)].map(
    (match) => match[1],
  );
}

/**
 * Vitest projects a command selects. Other tools take a `--project` flag too
 * (`tsc --project tsconfig.json`), so a command that does not run vitest
 * selects none.
 */
function vitestProjects(command: string): string[] {
  return VITEST_COMMAND_PATTERN.test(command)
    ? [...command.matchAll(PROJECT_FLAG_PATTERN)].map((match) => match[1])
    : [];
}

/**
 * One message per vitest project that a root script runs but that no
 * workflow-invoked script runs, naming both the project and the script.
 */
function findUnwiredProjects(
  scripts: Record<string, string>,
  workflowProjects: Set<string>,
): string[] {
  return Object.entries(scripts).flatMap(([name, command]) =>
    vitestProjects(command)
      .filter((project) => !workflowProjects.has(project))
      .map(
        (project) =>
          `vitest project "${project}" (from "npm run ${name}") is not ` +
          `run by any .github/workflows step`,
      ),
  );
}

describe('GitHub workflow / npm script wiring', () => {
  it('every npm run invocation in .github/workflows names a root script', async () => {
    const workflowFiles = await readWorkflowFiles();
    const invokedScripts = workflowFiles.flatMap(extractNpmRunScripts);

    expect(workflowFiles.length).toBeGreaterThan(0);
    expect(invokedScripts.length).toBeGreaterThan(0);
    expect(
      invokedScripts.filter(
        (name) => !Object.hasOwn(rootPackage.scripts, name),
      ),
      'These .github/workflows steps run npm scripts that the root ' +
        'package.json does not define, so the step cannot do what it says.',
    ).toEqual([]);
  });

  it('every vitest project a root test script targets is run by a workflow', async () => {
    const invokedScripts = new Set(
      (await readWorkflowFiles()).flatMap(extractNpmRunScripts),
    );
    const workflowProjects = new Set(
      Object.entries(rootPackage.scripts)
        .filter(([name]) => invokedScripts.has(name))
        .flatMap(([, command]) => vitestProjects(command)),
    );

    expect(workflowProjects.size).toBeGreaterThan(0);
    expect(
      findUnwiredProjects(rootPackage.scripts, workflowProjects),
      'A root test script targets a vitest project that no ' +
        '.github/workflows step runs, so those tests never execute in CI.',
    ).toEqual([]);
  });
});

describe('workflow script parsing', () => {
  it('ignores npm run invocations on commented-out lines', () => {
    expect(
      extractNpmRunScripts('      - name: Test\n        run: npm run test:x'),
    ).toEqual(['test:x']);
    expect(
      extractNpmRunScripts('      # - name: Test\n      #   run: npm run x'),
    ).toEqual([]);
  });

  it('reads both the --project name and --project=name spellings', () => {
    expect(
      vitestProjects('vitest run --project unit:core --project=e2e --coverage'),
    ).toEqual(['unit:core', 'e2e']);
    expect(vitestProjects('vitest run --coverage')).toEqual([]);
  });

  it('claims no project for a non-vitest tool that also takes --project', () => {
    expect(vitestProjects('tsc --project tsconfig.check.json')).toEqual([]);
  });

  it('rescans from the start of the input on a repeated call', () => {
    const command = 'vitest --project integration';
    expect(vitestProjects(command)).toEqual(['integration']);
    expect(vitestProjects(command)).toEqual(['integration']);

    const step = 'run: npm run build && npm run lint';
    expect(extractNpmRunScripts(step)).toEqual(['build', 'lint']);
    expect(extractNpmRunScripts(step)).toEqual(['build', 'lint']);
  });

  it('names every unwired project and the script that runs it', () => {
    expect(
      findUnwiredProjects(
        {
          test: 'vitest --project unit:core --project e2e',
          'test:foo': 'vitest --project foo',
          'ts:check': 'tsc --project tsconfig.check.json',
        },
        new Set(['unit:core']),
      ),
    ).toEqual([
      'vitest project "e2e" (from "npm run test") is not run by any ' +
        '.github/workflows step',
      'vitest project "foo" (from "npm run test:foo") is not run by any ' +
        '.github/workflows step',
    ]);
  });
});
