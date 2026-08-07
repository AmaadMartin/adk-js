/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {context} from '@opentelemetry/api';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {runAsyncGeneratorWithOtelContext} from '../../src/telemetry/tracing.js';

describe('runAsyncGeneratorWithOtelContext disposal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the wrapped generator finally block when the runtime generator is not disposable', async () => {
    let released = false;
    const gen = runAsyncGeneratorWithOtelContext(
      context.active(),
      null,
      async function* () {
        try {
          yield 1;
        } finally {
          released = true;
        }
      },
    );

    expect(await gen.next()).toEqual({value: 1, done: false});
    await gen[Symbol.asyncDispose]();

    expect(released).toBe(true);
    expect((await gen.next()).done).toBe(true);
  });

  it('finalises through return() even when the wrapped generator has its own disposer', async () => {
    const dispose = vi.fn(async (): Promise<void> => {});
    const returnFn = vi.fn(
      async (): Promise<IteratorResult<number, void>> => ({
        value: undefined,
        done: true,
      }),
    );
    const inner: AsyncGenerator<number, void, void> & AsyncDisposable = {
      next: async () => ({value: 1, done: false}),
      return: returnFn,
      throw: async () => ({value: undefined, done: true}),
      [Symbol.asyncDispose]: dispose,
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    const gen = runAsyncGeneratorWithOtelContext(
      context.active(),
      null,
      () => inner,
    );
    await gen[Symbol.asyncDispose]();

    expect(returnFn).toHaveBeenCalledTimes(1);
    expect(returnFn).toHaveBeenCalledWith(undefined);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('runs the wrapped generator finally block when the caller uses await using', async () => {
    let released = false;
    const makeGenerator = async function* () {
      try {
        yield 1;
      } finally {
        released = true;
      }
    };

    {
      await using gen = runAsyncGeneratorWithOtelContext(
        context.active(),
        null,
        makeGenerator,
      );
      expect(await gen.next()).toEqual({value: 1, done: false});
      expect(released).toBe(false);
    }

    expect(released).toBe(true);
  });

  it('binds the disposer to the same context as the other members', () => {
    const bind = vi.spyOn(context, 'bind');
    const ctx = context.active();

    const gen = runAsyncGeneratorWithOtelContext(ctx, null, async function* () {
      yield 1;
    });

    const boundMembers = [gen.next, gen.return, gen.throw];
    const disposerIndex = bind.mock.results.findIndex(
      (result) => result.value === gen[Symbol.asyncDispose],
    );
    expect(disposerIndex).toBeGreaterThanOrEqual(0);
    expect(bind.mock.calls[disposerIndex][0]).toBe(ctx);
    for (const member of boundMembers) {
      expect(bind.mock.results.map((result) => result.value)).toContain(member);
    }
    for (const call of bind.mock.calls) {
      expect(call[0]).toBe(ctx);
    }
  });

  it('still yields every value through for await and yield* delegation', async () => {
    const makeGenerator = async function* () {
      yield 1;
      yield 2;
      yield 3;
    };

    const forAwaitValues: number[] = [];
    for await (const value of runAsyncGeneratorWithOtelContext(
      context.active(),
      null,
      makeGenerator,
    )) {
      forAwaitValues.push(value);
    }
    expect(forAwaitValues).toEqual([1, 2, 3]);

    async function* outer(): AsyncGenerator<number, void, void> {
      yield* runAsyncGeneratorWithOtelContext(
        context.active(),
        null,
        makeGenerator,
      );
    }
    const delegatedValues: number[] = [];
    for await (const value of outer()) {
      delegatedValues.push(value);
    }
    expect(delegatedValues).toEqual([1, 2, 3]);
  });
});
