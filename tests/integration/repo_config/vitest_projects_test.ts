/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import type {TestProjectConfiguration} from 'vitest/config';
import vitestConfig from '../../../vitest.config.js';

/**
 * The root npm scripts select vitest projects with hand-written `--project`
 * flags, so a project declared in vitest.config.ts is not executed until some
 * script names it. Drift in either direction is silent — the affected tests
 * simply stop running — so these assertions turn it into a build failure.
 */

const PROJECT_FLAG = '--project';
const PROJECT_FLAG_EQ = `${PROJECT_FLAG}=`;

const rootScripts = (
  JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as {scripts: Record<string, string>}
).scripts;

/**
 * Names of the projects declared in vitest.config.ts. Throws on a project this
 * guard cannot read, because a shape it silently skipped would be exactly the
 * drift it exists to catch.
 */
function declaredProjects(
  projects: TestProjectConfiguration[] | undefined,
): string[] {
  if (!projects) {
    throw new Error(
      'vitest.config.ts declares no test.projects; the drift guard in ' +
        'tests/integration/repo_config needs updating.',
    );
  }
  return projects.map((project, index) => {
    const name =
      typeof project === 'object' && 'test' in project
        ? project.test?.name
        : undefined;
    if (typeof name !== 'string') {
      throw new Error(
        `Cannot read a string test.name from vitest.config.ts project ` +
          `#${index}; the drift guard in tests/integration/repo_config needs ` +
          `updating.`,
      );
    }
    return name;
  });
}

/** Project names selected by a `--project` flag in any root npm script. */
function referencedProjects(scripts: Record<string, string>): string[] {
  const names = new Set<string>();
  for (const script of Object.values(scripts)) {
    const tokens = script.split(/\s+/);
    for (const [index, token] of tokens.entries()) {
      if (token === PROJECT_FLAG) {
        names.add(tokens[index + 1]);
      } else if (token.startsWith(PROJECT_FLAG_EQ)) {
        names.add(token.slice(PROJECT_FLAG_EQ.length));
      }
    }
  }
  return [...names];
}

describe('vitest projects', () => {
  it('every project declared in vitest.config.ts is run by a root npm script', () => {
    const referenced = new Set(referencedProjects(rootScripts));

    expect(
      declaredProjects(vitestConfig.test?.projects).filter(
        (name) => !referenced.has(name),
      ),
      'These vitest projects are declared in vitest.config.ts but no root ' +
        'package.json script runs them, so their tests never execute. Add ' +
        '`--project <name>` to a test script, or delete the project.',
    ).toEqual([]);
  });

  it('every --project flag in a root npm script names a declared project', () => {
    const declared = new Set(declaredProjects(vitestConfig.test?.projects));

    expect(
      referencedProjects(rootScripts).filter((name) => !declared.has(name)),
      'These root package.json scripts select vitest projects that ' +
        'vitest.config.ts does not declare, so they match nothing. Drop the ' +
        'stale `--project <name>` flag, or declare the project.',
    ).toEqual([]);
  });
});

describe('vitest project parsing', () => {
  it('rejects a config that declares no projects', () => {
    expect(() => declaredProjects(undefined)).toThrow(
      /declares no test.projects/,
    );
  });

  it('rejects a project whose name it cannot read', () => {
    expect(() => declaredProjects(['glob/*', {test: {name: 'ok'}}])).toThrow(
      /project #0/,
    );
    expect(() => declaredProjects([{test: {}}])).toThrow(/project #0/);
  });

  it('reads both the --project name and --project=name spellings', () => {
    expect(
      referencedProjects({
        a: 'vitest --project unit:core --project=e2e',
        b: 'vitest run --project unit:core',
        c: 'tsc --noEmit',
      }),
    ).toEqual(['unit:core', 'e2e']);
  });
});
