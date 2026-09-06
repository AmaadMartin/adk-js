/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  UserPersona,
  UserPersonaRegistry,
  getBehaviorInstructionsStr,
  getViolationRubricsStr,
  isInputValidationError,
  userBehaviorModel,
  userPersonaModel,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {resetLogger, setLogger} from '../../../src/utils/logger.js';

function makePersona(id: string): UserPersona {
  return {id, description: `Persona ${id}`, behaviors: []};
}

function expectValidationMessage(run: () => unknown): string {
  try {
    run();
  } catch (error: unknown) {
    if (isInputValidationError(error)) {
      return error.message;
    }
    expect.fail(`Expected an InputValidationError, got ${String(error)}.`);
  }
  expect.fail('Expected an InputValidationError, but nothing was thrown.');
}

describe('render helpers', () => {
  it('renders an empty instruction list as an empty string', () => {
    const rendered = getBehaviorInstructionsStr({
      name: 'empty',
      description: 'No instructions.',
      behaviorInstructions: [],
      violationRubrics: ['violation1'],
    });

    expect(rendered).toBe('');
  });

  it('renders an empty rubric list as an empty string', () => {
    const rendered = getViolationRubricsStr({
      name: 'empty',
      description: 'No rubrics.',
      behaviorInstructions: ['instruction1'],
      violationRubrics: [],
    });

    expect(rendered).toBe('');
  });

  it('renders a single entry without a trailing newline', () => {
    const rendered = getBehaviorInstructionsStr({
      name: 'one',
      description: 'One instruction.',
      behaviorInstructions: ['only'],
      violationRubrics: [],
    });

    expect(rendered).toBe('  * only');
  });
});

describe('UserPersonaRegistry lookup keys', () => {
  it('holds nothing before anything is registered', () => {
    expect(new UserPersonaRegistry().getRegisteredPersonas()).toEqual([]);
  });

  it('registers a persona under a lookup id that differs from its own id', () => {
    const registry = new UserPersonaRegistry();
    const persona = makePersona('EXPERT');

    registry.registerPersona('house-style', persona);

    expect(registry.getPersona('house-style')).toBe(persona);
    expect(() => registry.getPersona('EXPERT')).toThrowError(
      'EXPERT not found in registry.',
    );
  });

  it('returns the personas in registration order', () => {
    const registry = new UserPersonaRegistry();
    const first = makePersona('first');
    const second = makePersona('second');
    const third = makePersona('third');

    registry.registerPersona('c', third);
    registry.registerPersona('a', first);
    registry.registerPersona('b', second);

    expect(registry.getRegisteredPersonas()).toEqual([third, first, second]);
  });

  it('keeps one entry when an id is registered twice', () => {
    const registry = new UserPersonaRegistry();
    const first = makePersona('first');
    const second = makePersona('second');

    registry.registerPersona('same', first);
    registry.registerPersona('same', second);

    expect(registry.getRegisteredPersonas()).toEqual([second]);
  });

  it('keeps registration order when an id is replaced', () => {
    const registry = new UserPersonaRegistry();
    registry.registerPersona('first', makePersona('first'));
    registry.registerPersona('second', makePersona('second'));

    registry.registerPersona('first', makePersona('replacement'));

    expect(registry.getRegisteredPersonas().map((entry) => entry.id)).toEqual([
      'replacement',
      'second',
    ]);
  });

  it('does not change the registry when the returned array is mutated', () => {
    const registry = new UserPersonaRegistry();
    const persona = makePersona('kept');
    registry.registerPersona('kept', persona);

    const personas = registry.getRegisteredPersonas();
    personas.pop();

    expect(registry.getRegisteredPersonas()).toEqual([persona]);
  });
});

describe('UserPersonaRegistry overwrite logging', () => {
  const debugCalls: string[] = [];

  beforeEach(() => {
    debugCalls.length = 0;
    setLogger({
      setLogLevel: () => {},
      log: () => {},
      debug: (...args: unknown[]) => {
        debugCalls.push(args.map((arg) => String(arg)).join(' '));
      },
      info: () => {},
      warn: () => {},
      error: () => {},
    });
  });

  afterEach(() => {
    resetLogger();
  });

  it('logs nothing when the id is new', () => {
    new UserPersonaRegistry().registerPersona('fresh', makePersona('fresh'));

    expect(debugCalls).toEqual([]);
  });

  it('logs the id once when an existing id is overwritten', () => {
    const registry = new UserPersonaRegistry();
    registry.registerPersona('same', makePersona('first'));

    registry.registerPersona('same', makePersona('second'));

    expect(debugCalls).toEqual([
      'Updating the user persona registered as same.',
    ]);
  });
});

describe('userBehaviorModel', () => {
  it('accepts the adk-python snake_case spelling', () => {
    const behavior = userBehaviorModel.parse({
      name: 'test_behavior',
      description: 'Test behavior description.',
      behavior_instructions: ['instruction1'],
      violation_rubrics: ['violation1'],
    });

    expect(behavior.behaviorInstructions).toEqual(['instruction1']);
    expect(behavior.violationRubrics).toEqual(['violation1']);
  });

  it('rejects an unrecognized key', () => {
    expect(
      expectValidationMessage(() =>
        userBehaviorModel.parse({
          name: 'test_behavior',
          description: 'Test behavior description.',
          behaviorInstructions: [],
          violationRubrics: [],
          behaviourInstructions: [],
        }),
      ),
    ).toContain('behaviourInstructions');
  });
});

describe('userPersonaModel', () => {
  it('rejects a persona whose behaviors are not behaviors', () => {
    expect(
      expectValidationMessage(() =>
        userPersonaModel.parse({
          id: 'CUSTOM',
          description: 'Inline persona.',
          behaviors: ['Be terse'],
        }),
      ),
    ).toContain('behaviors.0');
  });
});
