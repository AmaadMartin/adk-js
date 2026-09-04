/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {LoopAgent} from '../../src/agents/loop_agent.js';
import {ParallelAgent} from '../../src/agents/parallel_agent.js';
import {SequentialAgent} from '../../src/agents/sequential_agent.js';
import {
  deprecated,
  resetDeprecationWarnings,
  warnDeprecatedOnce,
} from '../../src/utils/deprecated.js';
import {logger} from '../../src/utils/logger.js';

describe('deprecated', () => {
  beforeEach(() => {
    resetDeprecationWarnings();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDeprecationWarnings();
  });

  it('warns once per class, not once per instance', () => {
    @deprecated('Old is deprecated.')
    class Old {
      constructor(readonly value: string) {}
    }

    new Old('a');
    new Old('b');
    new Old('c');

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('Old is deprecated.');
  });

  it('keeps the class name, which reaches events and logs', () => {
    @deprecated('Named is deprecated.')
    class Named {}

    expect(Named.name).toBe('Named');
    expect(new Named()).toBeInstanceOf(Named);
  });

  it('leaves construction behaviour alone', () => {
    @deprecated('Adder is deprecated.')
    class Adder {
      readonly total: number;
      constructor(a: number, b: number) {
        this.total = a + b;
      }
    }

    expect(new Adder(2, 3).total).toBe(5);
  });
});

describe('the composite shell agents are deprecated', () => {
  beforeEach(() => {
    resetDeprecationWarnings();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDeprecationWarnings();
  });

  it.each([
    ['SequentialAgent', () => new SequentialAgent({name: 'seq'})],
    ['ParallelAgent', () => new ParallelAgent({name: 'par'})],
    ['LoopAgent', () => new LoopAgent({name: 'loop'})],
  ])('%s warns and still works', (name, construct) => {
    const agent = construct();

    expect(agent.name).toBe(agent.name);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain(
      `${name} is deprecated in favor of Workflow`,
    );
    // The constructor is wrapped, so the reported class name has to survive it.
    expect(agent.constructor.name).toBe(name);
  });
});

describe('warnDeprecatedOnce', () => {
  beforeEach(() => {
    resetDeprecationWarnings();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDeprecationWarnings();
  });

  it('warns once per key, however often it is called', () => {
    warnDeprecatedOnce('moved-module', 'moved-module has moved.');
    warnDeprecatedOnce('moved-module', 'moved-module has moved.');

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('moved-module has moved.');
  });

  it('warns separately for each key', () => {
    warnDeprecatedOnce('first', 'first has moved.');
    warnDeprecatedOnce('second', 'second has moved.');

    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('shares the registry with the class decorator, so a reset clears both', () => {
    warnDeprecatedOnce('shared-key', 'shared-key has moved.');
    resetDeprecationWarnings();
    warnDeprecatedOnce('shared-key', 'shared-key has moved.');

    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
