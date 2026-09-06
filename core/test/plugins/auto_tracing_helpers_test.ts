/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python`
 * `tests/unittests/plugins/test_auto_tracing_helpers.py`, at commit
 * `a119dd7751082dbbd9a65f71e359abdc2be659cc`. Each `it(...)` keeps the
 * original Python test name so a reviewer can find its counterpart.
 */

import {Attributes} from '@opentelemetry/api';
import {
  AlwaysOffSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {afterAll, beforeEach, describe, expect, it} from 'vitest';
import {
  Caps,
  DEFAULT_MAX_RECORDED_YIELDS,
  DEFAULT_MAX_REPR_LEN,
  StreamResult,
  TracedFunction,
  buildTracingWrapper,
  displayNameFor,
  isTracingWrapper,
  nameValuePairs,
  positionalParamNames,
  recordIoOnSpan,
} from '../../src/plugins/auto_tracing_helpers.js';

const CAPS: Caps = {
  maxReprLen: DEFAULT_MAX_REPR_LEN,
  maxRecordedYields: DEFAULT_MAX_RECORDED_YIELDS,
};

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
const tracer = provider.getTracer('auto_tracing_helpers_test');

/**
 * A tracer that hands out spans with a valid context that never record. It is
 * eligible under `tracerWillRecord`, so wrappers are still built.
 */
const offExporter = new InMemorySpanExporter();
const offProvider = new BasicTracerProvider({
  sampler: new AlwaysOffSampler(),
  spanProcessors: [new SimpleSpanProcessor(offExporter)],
});
const nonRecordingTracer = offProvider.getTracer('auto_tracing_helpers_test');

beforeEach(() => {
  exporter.reset();
  offExporter.reset();
});

afterAll(async () => {
  await provider.shutdown();
  await offProvider.shutdown();
});

/** Returns the attributes of the single finished span called `name`. */
function attributesOf(name: string): Attributes {
  const spans = exporter.getFinishedSpans().filter((s) => s.name === name);
  expect(spans.map((s) => s.name)).toEqual([name]);
  return spans[0].attributes;
}

function moduleLevelFn(x: unknown): unknown {
  return x;
}

class Holder {
  method(): void {}
}

function syncShape(x: unknown): unknown {
  return x;
}

async function coroutineShape(x: unknown): Promise<unknown> {
  return x;
}

function* generatorShape(x: unknown): Generator<unknown> {
  yield x;
}

async function* asyncGeneratorShape(x: unknown): AsyncGenerator<unknown> {
  yield x;
}

/** Names the callable kind of `fn` by identity against realm intrinsics. */
function callableShape(fn: TracedFunction): string {
  const prototype = Object.getPrototypeOf(fn) as object;
  if (prototype === Object.getPrototypeOf(asyncGeneratorShape)) {
    return 'asyncgen';
  }
  if (prototype === Object.getPrototypeOf(coroutineShape)) {
    return 'coroutine';
  }
  if (prototype === Object.getPrototypeOf(generatorShape)) {
    return 'generator';
  }
  return 'sync';
}

describe('auto tracing helpers — introspection', () => {
  it('test_positional_param_names_keeps_only_positional_kinds', () => {
    // Python's counterpart also drops keyword-only parameters. JavaScript has
    // none, so this pins the rest parameter ending the list instead.
    function fn(posOnly: unknown, normal: unknown, ...rest: unknown[]): void {
      void posOnly;
      void normal;
      void rest;
    }

    expect(positionalParamNames(fn)).toEqual(['posOnly', 'normal']);
  });

  it('test_positional_param_names_empty_when_not_introspectable', () => {
    expect(positionalParamNames({})).toEqual([]);
  });

  it('test_display_name_for_keeps_owner_and_name', () => {
    expect(displayNameFor(moduleLevelFn)).toBe('moduleLevelFn');
    expect(displayNameFor(Holder.prototype.method, 'Holder')).toBe(
      'Holder.method',
    );
  });

  it('names an unnamed function "anonymous"', () => {
    const unnamed = Object.defineProperty(() => 1, 'name', {value: ''});

    expect(displayNameFor(unnamed)).toBe('anonymous');
    expect(displayNameFor(unnamed, 'Owner')).toBe('Owner.anonymous');
  });
});

describe('auto tracing helpers — argument capture', () => {
  it('test_name_value_pairs_falls_back_to_index_names_for_extra_args', () => {
    expect(nameValuePairs(['x'], [1, 2, 3], CAPS)).toEqual([
      ['x', '1'],
      ['arg1', '2'],
      ['arg2', '3'],
    ]);
  });

  it('test_name_value_pairs_caps_long_reprs', () => {
    const caps: Caps = {maxReprLen: 5, maxRecordedYields: 16};

    // The rendering of the value is `"yyyyyyyyyy"` -- 12 characters, so 7 are
    // dropped.
    expect(nameValuePairs(['x'], ['y'.repeat(10)], caps)).toEqual([
      ['x', '"yyyy...[7 more chars]'],
    ]);
  });
});

describe('auto tracing helpers — span attributes', () => {
  it('test_record_io_on_span_writes_args_and_return', () => {
    const span = tracer.startSpan('record_io_return');

    recordIoOnSpan(span, [['x', '1']], 'ok', undefined, CAPS);
    span.end();

    expect(attributesOf('record_io_return')).toEqual({
      'adk.fn.arg.x': '1',
      'adk.fn.return': '"ok"',
    });
  });

  it('drops a credential-named pair a caller did not filter', () => {
    // nameValuePairs already drops these, but recordIoOnSpan is public and
    // may be handed pairs that never went through it.
    const span = tracer.startSpan('record_io_unfiltered');

    recordIoOnSpan(
      span,
      [
        ['apiKey', '"leaked"'],
        ['x', '1'],
      ],
      'ok',
      undefined,
      CAPS,
    );
    span.end();

    const attributes = attributesOf('record_io_unfiltered');
    expect(attributes).not.toHaveProperty('adk.fn.arg.apiKey');
    expect(attributes['adk.fn.arg.x']).toBe('1');
  });

  it('test_record_io_on_span_records_exception_instead_of_return', () => {
    const span = tracer.startSpan('record_io_exception');

    recordIoOnSpan(span, [['x', '1']], 'unused', new RangeError('boom'), CAPS);
    span.end();

    const attributes = attributesOf('record_io_exception');
    expect(attributes['adk.fn.arg.x']).toBe('1');
    expect(attributes['adk.fn.exc_type']).toBe('RangeError');
    expect(attributes['adk.fn.exc_repr']).toContain('boom');
    // A raising call has no return value to record.
    expect(attributes).not.toHaveProperty('adk.fn.return');
  });
});

describe('auto tracing helpers — StreamResult', () => {
  it('test_stream_result_repr_for_empty_stream', () => {
    expect(new StreamResult([], CAPS, 0).render()).toBe(
      '<generator: 0 items yielded>',
    );
  });

  it('test_stream_result_repr_reports_total_beyond_sample', () => {
    expect(new StreamResult([1, 2], CAPS, 5).render()).toBe(
      '<generator: 5 items yielded; first 2: [1, 2] ... + 3 more>',
    );
  });

  it('test_stream_result_repr_has_no_more_suffix_when_fully_sampled', () => {
    expect(new StreamResult([1, 2], CAPS, 2).render()).toBe(
      '<generator: 2 items yielded; first 2: [1, 2]>',
    );
  });
});

describe('auto tracing helpers — wrapper construction', () => {
  it('test_build_tracing_wrapper_preserves_callable_shape', () => {
    const cases: ReadonlyArray<[TracedFunction, string]> = [
      [syncShape, 'sync'],
      [coroutineShape, 'coroutine'],
      [generatorShape, 'generator'],
      [asyncGeneratorShape, 'asyncgen'],
    ];

    for (const [fn, expectedShape] of cases) {
      const wrapped = buildTracingWrapper(fn, tracer, CAPS);
      expect(callableShape(wrapped)).toBe(expectedShape);
      expect(isTracingWrapper(wrapped)).toBe(true);
      expect(wrapped.name).toBe(fn.name);
    }
  });

  it('test_build_tracing_wrapper_records_io_under_the_display_name', () => {
    function addOne(x: unknown): number {
      return Number(x) + 1;
    }

    const wrapped = buildTracingWrapper(addOne, tracer, CAPS);

    expect(wrapped(3)).toBe(4);
    expect(attributesOf(displayNameFor(addOne))).toEqual({
      'adk.fn.arg.x': '3',
      'adk.fn.return': '4',
    });
  });

  it('test_build_tracing_wrapper_records_awaited_result', async () => {
    async function double(x: unknown): Promise<number> {
      return Number(x) * 2;
    }

    const wrapped = buildTracingWrapper(double, tracer, CAPS);

    expect(await wrapped(4)).toBe(8);
    expect(attributesOf('double')).toEqual({
      'adk.fn.arg.x': '4',
      'adk.fn.return': '8',
    });
  });

  it('test_build_tracing_wrapper_records_nothing_on_non_recording_span', () => {
    // A non-recording span discards attributes anyway, so what the guard
    // actually saves is the rendering work. The proxy counts every attempt to
    // render its argument.
    let renderAttempts = 0;
    const argument = new Proxy(
      {visible: 1},
      {
        ownKeys(target: object): ArrayLike<string | symbol> {
          renderAttempts++;
          return Reflect.ownKeys(target);
        },
      },
    );
    function addOne(x: unknown): number {
      void x;
      return 1;
    }
    const wrapped = buildTracingWrapper(addOne, nonRecordingTracer, CAPS);

    expect(wrapped(argument)).toBe(1);

    expect(renderAttempts).toBe(0);
    expect(offExporter.getFinishedSpans()).toEqual([]);
  });
});
