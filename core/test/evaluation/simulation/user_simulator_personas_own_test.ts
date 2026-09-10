/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cases the adk-python suite for `user_simulator_personas` does not cover:
 * empty and single-entry bullet lists, entries the formatter must not rewrite,
 * the order and freshness of the registered persona list, and the debug line
 * an overwrite writes.
 */

import {
  LogLevel,
  NotFoundError,
  UserPersonaRegistry,
  getBehaviorInstructionsStr,
  getViolationRubricsStr,
  setLogger,
  type Logger,
  type UserBehavior,
  type UserPersona,
} from '@google/adk';
import {afterEach, describe, expect, it} from 'vitest';
import {resetLogger} from '../../../src/utils/logger.js';

function makeBehavior(overrides: Partial<UserBehavior> = {}): UserBehavior {
  return {
    name: 'behavior',
    description: 'A behavior.',
    behaviorInstructions: [],
    violationRubrics: [],
    ...overrides,
  };
}

function makePersona(id: string): UserPersona {
  return {id, description: `Persona ${id}.`, behaviors: []};
}

/** Records every debug line, so a test can assert what the registry logged. */
class RecordingLogger implements Logger {
  readonly debugMessages: string[] = [];

  setLogLevel(_level: LogLevel): void {}
  log(_level: LogLevel, ..._args: unknown[]): void {}
  debug(...args: unknown[]): void {
    this.debugMessages.push(args.join(' '));
  }
  info(..._args: unknown[]): void {}
  warn(..._args: unknown[]): void {}
  error(..._args: unknown[]): void {}
}

describe('getBehaviorInstructionsStr', () => {
  it('returns an empty string for no instructions', () => {
    expect(getBehaviorInstructionsStr(makeBehavior())).toBe('');
  });

  it('returns one bullet, with no trailing newline, for one instruction', () => {
    const behavior = makeBehavior({behaviorInstructions: ['only']});

    expect(getBehaviorInstructionsStr(behavior)).toBe('  * only');
  });

  it('does not indent a continuation line inside an instruction', () => {
    const behavior = makeBehavior({behaviorInstructions: ['first\nsecond']});

    expect(getBehaviorInstructionsStr(behavior)).toBe('  * first\nsecond');
  });

  it('keeps a $ pattern in an instruction verbatim', () => {
    const behavior = makeBehavior({behaviorInstructions: ['say $& and $1']});

    expect(getBehaviorInstructionsStr(behavior)).toBe('  * say $& and $1');
  });

  it('reads the instructions, not the rubrics', () => {
    const behavior = makeBehavior({
      behaviorInstructions: ['instruction'],
      violationRubrics: ['rubric'],
    });

    expect(getBehaviorInstructionsStr(behavior)).toBe('  * instruction');
  });
});

describe('getViolationRubricsStr', () => {
  it('returns an empty string for no rubrics', () => {
    expect(getViolationRubricsStr(makeBehavior())).toBe('');
  });

  it('returns one bullet, with no trailing newline, for one rubric', () => {
    const behavior = makeBehavior({violationRubrics: ['only']});

    expect(getViolationRubricsStr(behavior)).toBe('  * only');
  });

  it('does not indent a continuation line inside a rubric', () => {
    const behavior = makeBehavior({violationRubrics: ['first\nsecond']});

    expect(getViolationRubricsStr(behavior)).toBe('  * first\nsecond');
  });

  it('keeps a $ pattern in a rubric verbatim', () => {
    const behavior = makeBehavior({violationRubrics: ['say $& and $1']});

    expect(getViolationRubricsStr(behavior)).toBe('  * say $& and $1');
  });

  it('reads the rubrics, not the instructions', () => {
    const behavior = makeBehavior({
      behaviorInstructions: ['instruction'],
      violationRubrics: ['rubric'],
    });

    expect(getViolationRubricsStr(behavior)).toBe('  * rubric');
  });
});

describe('UserPersonaRegistry', () => {
  afterEach(() => {
    resetLogger();
  });

  it('has no registered personas when it is new', () => {
    expect(new UserPersonaRegistry().getRegisteredPersonas()).toEqual([]);
  });

  it('reports an empty id in the not-found message', () => {
    const registry = new UserPersonaRegistry();

    expect(() => registry.getPersona('')).toThrow(NotFoundError);
    expect(() => registry.getPersona('')).toThrow(' not found in registry.');
  });

  it('registers a persona under an id that differs from its own id', () => {
    const registry = new UserPersonaRegistry();
    const persona = makePersona('own_id');

    registry.registerPersona('registered_id', persona);

    expect(registry.getPersona('registered_id')).toBe(persona);
    expect(() => registry.getPersona('own_id')).toThrow(NotFoundError);
  });

  it('lists the personas in registration order', () => {
    const registry = new UserPersonaRegistry();
    const first = makePersona('first');
    const second = makePersona('second');

    registry.registerPersona('first', first);
    registry.registerPersona('second', second);

    expect(registry.getRegisteredPersonas()).toEqual([first, second]);
  });

  it('replaces a persona in place, keeping its position and the count', () => {
    const registry = new UserPersonaRegistry();
    const first = makePersona('first');
    const second = makePersona('second');
    const replacement = makePersona('replacement');

    registry.registerPersona('first', first);
    registry.registerPersona('second', second);
    registry.registerPersona('first', replacement);

    expect(registry.getRegisteredPersonas()).toEqual([replacement, second]);
  });

  it('returns a fresh list that a caller cannot mutate the registry through', () => {
    const registry = new UserPersonaRegistry();
    const persona = makePersona('persona');
    registry.registerPersona('persona', persona);

    const personas = registry.getRegisteredPersonas();
    personas.pop();

    expect(registry.getRegisteredPersonas()).toEqual([persona]);
  });

  it('logs the id it overwrites, and logs nothing for a new id', () => {
    const recordingLogger = new RecordingLogger();
    setLogger(recordingLogger);
    const registry = new UserPersonaRegistry();

    registry.registerPersona('persona', makePersona('persona'));
    expect(recordingLogger.debugMessages).toEqual([]);

    registry.registerPersona('persona', makePersona('replacement'));
    expect(recordingLogger.debugMessages).toEqual([
      'Updating the user persona registered as persona.',
    ]);
  });
});
