/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {parseArgs} from 'node:util';
import {describe, expect, it} from 'vitest';
import type {TestProjectConfiguration} from 'vitest/config';
import rootPackage from '../../../package.json' with {type: 'json'};
import vitestConfig from '../../../vitest.config.js';

const GUARD_DIR = 'tests/integration/repo_config';

/** Names of the projects declared in vitest.config.ts. */
function declaredProjects(
  projects: TestProjectConfiguration[] | undefined,
): string[] {
  if (!projects) {
    throw new Error(
      `vitest.config.ts declares no test.projects, so ${GUARD_DIR} cannot ` +
        'check them against the root npm scripts.',
    );
  }
  // Fail closed: an entry this helper cannot name is exactly the drift the
  // guard exists to catch, so skipping it would defeat the assertions below.
  return projects.map((project, index) => {
    const name =
      typeof project === 'object' && 'test' in project
        ? project.test?.name
        : undefined;
    if (typeof name !== 'string') {
      throw new Error(
        `vitest.config.ts project #${index} has no string test.name. Give it ` +
          `one, or teach ${GUARD_DIR} to read the new shape.`,
      );
    }
    return name;
  });
}

/** Project names selected by a `--project` flag in any root npm script. */
function referencedProjects(scripts: Record<string, string>): string[] {
  const names = new Set<string>();
  for (const [script, command] of Object.entries(scripts)) {
    // strict: false because the non-test scripts carry flags this guard does
    // not model, and strict parseArgs rejects unknown options.
    const {values} = parseArgs({
      args: command.split(/\s+/),
      options: {project: {type: 'string', multiple: true}},
      strict: false,
    });
    for (const name of values.project ?? []) {
      if (typeof name !== 'string') {
        throw new Error(
          `Root npm script "${script}" passes --project with no project name.`,
        );
      }
      names.add(name);
    }
  }
  return [...names];
}

describe('vitest projects', () => {
  // vitest.config.ts and the root package.json scripts are coupled by hand
  // only, so either list can drift from the other without any error.
  const declared = declaredProjects(vitestConfig.test?.projects);
  const referenced = new Set(referencedProjects(rootPackage.scripts));

  it('every declared project is run by a root npm script', () => {
    expect(
      declared.filter((name) => !referenced.has(name)),
      'These vitest projects run in no root npm script. Add ' +
        '--project <name> to a test script in package.json, or delete the ' +
        'project from vitest.config.ts.',
    ).toEqual([]);
  });

  it('every --project flag in a root npm script names a declared project', () => {
    // vitest exits 0 on an unmatched --project as long as a sibling --project
    // in the same script matches, so it never reports a stale flag itself.
    expect(
      [...referenced].filter((name) => !declared.includes(name)),
      'These root npm scripts select vitest projects that do not exist. Drop ' +
        'the stale --project flag from package.json, or declare the project ' +
        'in vitest.config.ts.',
    ).toEqual([]);
  });
});

describe('vitest project parsing', () => {
  it('rejects a config with no projects', () => {
    expect(() => declaredProjects(undefined)).toThrow(
      /declares no test\.projects/,
    );
  });

  it('rejects a project entry it cannot name', () => {
    expect(() => declaredProjects(['glob/*', {test: {name: 'ok'}}])).toThrow(
      /project #0/,
    );
    expect(() => declaredProjects([{}])).toThrow(/project #0/);
    expect(() => declaredProjects([{test: undefined}])).toThrow(/project #0/);
    expect(() => declaredProjects([{test: {}}])).toThrow(/project #0/);
  });

  it('collects both --project spellings across scripts', () => {
    expect(
      referencedProjects({
        a: 'vitest --project unit:core --project=e2e',
        b: 'vitest run --project unit:core',
        c: 'tsc --noEmit',
      }),
    ).toEqual(['unit:core', 'e2e']);
  });

  it('rejects a --project flag with no project name', () => {
    expect(() => referencedProjects({a: 'vitest --project'})).toThrow(
      /no project name/,
    );
  });
});
