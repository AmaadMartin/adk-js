/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/plugins/test_auto_tracing_helpers.py` @ `main`.
 *
 * Three `public_slot_names` tests are not ported: `__slots__` has no
 * JavaScript analogue, so the helper does not exist here. The
 * keyword-argument test is replaced by the JavaScript equivalent, a trailing
 * options object.
 */

import {trace, type Attributes, type Tracer} from '@opentelemetry/api';
import {
  AlwaysOffSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  AUTO_TRACING_WRAPPED,
  StreamResult,
  buildTracingWrapper,
  createCaps,
  displayNameFor,
  nameValuePairs,
  positionalParamNames,
  recordIoOnSpan,
  restParamName,
  safeRepr,
} from '@google/adk';

const CAPS = createCaps();
const SENTINEL_TOKEN = 'sentinel-token-do-not-trace';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
const tracer: Tracer = provider.getTracer('auto-tracing-helpers-test');

/**
 * A tracer that hands out valid but unsampled spans: `tracerWillRecord` is
 * true for it, while every span it opens reports `isRecording() === false`.
 */
const silentProvider = new BasicTracerProvider({
  sampler: new AlwaysOffSampler(),
});
const silentTracer: Tracer = silentProvider.getTracer('auto-tracing-silent');

beforeEach(() => {
  exporter.reset();
});

afterAll(async () => {
  await provider.shutdown();
  await silentProvider.shutdown();
});

function attributesOf(spanName: string): Attributes {
  const matches = exporter
    .getFinishedSpans()
    .filter((span) => span.name === spanName);
  expect(matches.map((span) => span.name)).toEqual([spanName]);
  return matches[0].attributes;
}

function moduleLevelFn(x: number): number {
  return x;
}

class Holder {
  method(): null {
    return null;
  }
}

function syncShape(x: number): number {
  return x;
}

async function coroutineShape(x: number): Promise<number> {
  return x;
}

function* generatorShape(x: number): Generator<number> {
  yield x;
}

async function* asyncGeneratorShape(x: number): AsyncGenerator<number> {
  yield x;
}

function callableShape(fn: unknown): string {
  return Object.prototype.toString.call(fn);
}

describe('auto tracing helpers', () => {
  it('test_positional_param_names_keeps_only_positional_kinds', () => {
    function fn(first: number, second: string, ...rest: number[]): void {
      void first;
      void second;
      void rest;
    }
    function plain(first: number, second: string): void {
      void first;
      void second;
    }

    // A rest parameter stands in for Python's `*args`, which the reference
    // excludes as VAR_POSITIONAL while keeping the named positionals.
    expect(positionalParamNames(fn)).toEqual(['first', 'second']);
    expect(positionalParamNames(plain)).toEqual(['first', 'second']);
    expect(restParamName(fn)).toBe('rest');
    expect(restParamName(plain)).toBeUndefined();
  });

  it('test_positional_param_names_empty_when_not_introspectable', () => {
    expect(positionalParamNames({})).toEqual([]);
    expect(positionalParamNames(undefined)).toEqual([]);
  });

  it('test_name_value_pairs_skips_self_and_names_positionals', () => {
    const pairs = nameValuePairs({
      paramNames: ['self', 'x', 'y'],
      args: [{}, 1, 'a'],
      caps: CAPS,
    });

    expect(pairs).toEqual([
      {name: 'x', value: '1'},
      {name: 'y', value: "'a'"},
    ]);
  });

  it('test_name_value_pairs_falls_back_to_index_names_for_extra_args', () => {
    const pairs = nameValuePairs({
      paramNames: ['x'],
      args: [1, 2, 3],
      caps: CAPS,
    });

    expect(pairs).toEqual([
      {name: 'x', value: '1'},
      {name: 'arg1', value: '2'},
      {name: 'arg2', value: '3'},
    ]);
  });

  it('records a trailing options object as one argument with its secrets masked', () => {
    // Replaces the reference's `test_name_value_pairs_appends_kwargs_after_
    // positionals`: JavaScript has no keyword arguments, and the idiom it
    // maps to is a trailing options object.
    const pairs = nameValuePairs({
      paramNames: ['x', 'options'],
      args: [1, {flag: true, note: 'hi', apiKey: SENTINEL_TOKEN}],
      caps: CAPS,
    });

    expect(pairs).toEqual([
      {name: 'x', value: '1'},
      {name: 'options', value: "{flag: true, note: 'hi', apiKey: <String>}"},
    ]);
  });

  it('drops a secret-named argument instead of rendering it', () => {
    // `recordIoOnSpan` filters again, so only this assertion tells the two
    // guards apart: the pair must never be rendered in the first place.
    const pairs = nameValuePairs({
      paramNames: ['user', 'token'],
      args: ['alice', SENTINEL_TOKEN],
      caps: CAPS,
    });

    expect(pairs).toEqual([{name: 'user', value: "'alice'"}]);
  });

  it('test_name_value_pairs_caps_long_reprs', () => {
    const caps = createCaps({maxReprLen: 5});

    const pairs = nameValuePairs({
      paramNames: ['x'],
      args: ['y'.repeat(10)],
      caps,
    });

    // The rendering is "'yyyyyyyyyy'" -- 12 characters, so 7 are dropped.
    expect(pairs).toEqual([{name: 'x', value: "'yyyy...[7 more chars]"}]);
  });

  it('test_record_io_on_span_writes_args_and_return', () => {
    const span = tracer.startSpan('record_io_return');

    recordIoOnSpan({
      span,
      pairs: [{name: 'x', value: '1'}],
      result: 'ok',
      error: undefined,
      caps: CAPS,
    });
    span.end();

    expect(attributesOf('record_io_return')).toEqual({
      'adk.fn.arg.x': '1',
      'adk.fn.return': "'ok'",
    });
  });

  it('test_record_io_on_span_records_exception_instead_of_return', () => {
    class ValueError extends Error {}
    const span = tracer.startSpan('record_io_exception');

    recordIoOnSpan({
      span,
      pairs: [{name: 'x', value: '1'}],
      result: 'unused',
      error: new ValueError('boom'),
      caps: CAPS,
    });
    span.end();

    const attributes = attributesOf('record_io_exception');
    expect(attributes['adk.fn.arg.x']).toBe('1');
    expect(attributes['adk.fn.exc_type']).toBe('ValueError');
    expect(attributes['adk.fn.exc_repr']).toContain('boom');
    // A call that threw has no return value to record.
    expect(attributes).not.toHaveProperty('adk.fn.return');
  });

  it('test_display_name_for_keeps_owner_and_name', () => {
    // JavaScript has no `__qualname__`, so the owner is passed explicitly.
    expect(displayNameFor(moduleLevelFn)).toBe('moduleLevelFn');
    expect(displayNameFor(Holder.prototype.method, 'Holder')).toBe(
      'Holder.method',
    );
  });

  it('test_stream_result_repr_for_empty_stream', () => {
    expect(String(new StreamResult([], CAPS, 0))).toBe(
      '<generator: 0 items yielded>',
    );
  });

  it('test_stream_result_repr_reports_total_beyond_sample', () => {
    expect(String(new StreamResult([1, 2], CAPS, 5))).toBe(
      '<generator: 5 items yielded; first 2: [1, 2] ... + 3 more>',
    );
  });

  it('test_stream_result_repr_has_no_more_suffix_when_fully_sampled', () => {
    expect(String(new StreamResult([1, 2], CAPS, 2))).toBe(
      '<generator: 2 items yielded; first 2: [1, 2]>',
    );
  });

  it('test_build_tracing_wrapper_returns_original_for_noop_tracer', () => {
    // No global tracer provider is registered in this file, so the API hands
    // back a tracer that never records.
    const wrapped = buildTracingWrapper({
      fn: syncShape,
      tracer: trace.getTracer('no-provider-registered'),
      caps: CAPS,
    });

    expect(wrapped).toBe(syncShape);
    expect(AUTO_TRACING_WRAPPED in syncShape).toBe(false);
  });

  it('test_build_tracing_wrapper_preserves_callable_shape', () => {
    for (const fn of [
      syncShape,
      coroutineShape,
      generatorShape,
      asyncGeneratorShape,
    ]) {
      const wrapped = buildTracingWrapper({fn, tracer, caps: CAPS});

      expect(callableShape(wrapped)).toBe(callableShape(fn));
      expect(wrapped.name).toBe(fn.name);
      expect(
        Object.getOwnPropertyDescriptor(wrapped, AUTO_TRACING_WRAPPED),
      ).toMatchObject({value: true, enumerable: false});
    }
  });

  it('marks a wrapper with the global symbol so two package copies agree', () => {
    const wrapped = buildTracingWrapper({fn: syncShape, tracer, caps: CAPS});

    expect(AUTO_TRACING_WRAPPED).toBe(Symbol.for('adk.auto_tracing.wrapped'));
    expect(AUTO_TRACING_WRAPPED in wrapped).toBe(true);
  });

  it('test_build_tracing_wrapper_records_io_under_the_display_name', () => {
    function addOne(x: number): number {
      return x + 1;
    }
    const wrapped = buildTracingWrapper({fn: addOne, tracer, caps: CAPS});

    expect(wrapped(3)).toBe(4);
    expect(attributesOf(displayNameFor(addOne))).toEqual({
      'adk.fn.arg.x': '3',
      'adk.fn.return': '4',
    });
  });

  it('test_build_tracing_wrapper_records_awaited_result', async () => {
    async function double(x: number): Promise<number> {
      return x * 2;
    }
    const wrapped = buildTracingWrapper({fn: double, tracer, caps: CAPS});

    expect(await wrapped(4)).toBe(8);
    expect(attributesOf('double')).toEqual({
      'adk.fn.arg.x': '4',
      'adk.fn.return': '8',
    });
  });

  it('test_build_tracing_wrapper_records_nothing_on_non_recording_span', () => {
    let reads = 0;
    const probe = {
      get marker(): number {
        reads += 1;
        return 1;
      },
    };
    function identity(value: unknown): unknown {
      return value;
    }
    const wrapped = buildTracingWrapper({
      fn: identity,
      tracer: silentTracer,
      caps: CAPS,
    });

    expect(wrapped(probe)).toBe(probe);
    // Rendering the argument would read the probe. Nothing did, so nothing
    // was recorded onto the non-recording span.
    expect(reads).toBe(0);
  });

  it('renders a thrown error and rethrows it unchanged', () => {
    class KaboomError extends Error {}
    const failure = new KaboomError('kaboom');
    function boom(): never {
      throw failure;
    }
    const wrapped = buildTracingWrapper({fn: boom, tracer, caps: CAPS});

    expect(() => wrapped()).toThrow(failure);
    expect(attributesOf('boom')).toEqual({
      'adk.fn.exc_type': 'KaboomError',
      'adk.fn.exc_repr': "KaboomError('kaboom')",
    });
  });

  it('rethrows unchanged from an async wrapper and records the error', async () => {
    const failure = new TypeError('async boom');
    async function boomAsync(): Promise<never> {
      throw failure;
    }
    const wrapped = buildTracingWrapper({fn: boomAsync, tracer, caps: CAPS});

    await expect(wrapped()).rejects.toBe(failure);
    expect(attributesOf('boomAsync')).toEqual({
      'adk.fn.exc_type': 'TypeError',
      'adk.fn.exc_repr': "TypeError('async boom')",
    });
  });

  it('records the error a generator throws part way through', () => {
    const failure = new Error('mid-stream');
    function* halfway(): Generator<number> {
      yield 1;
      throw failure;
    }
    const wrapped = buildTracingWrapper({fn: halfway, tracer, caps: CAPS});

    expect(() => [...wrapped()]).toThrow(failure);
    const attributes = attributesOf('halfway');
    expect(attributes['adk.fn.exc_type']).toBe('Error');
    expect(attributes['adk.fn.return']).toBeUndefined();
    expect(attributes['adk.fn.exc_repr']).toBe("Error('mid-stream')");
  });

  it('records the error an async generator throws part way through', async () => {
    const failure = new Error('async mid-stream');
    async function* halfwayAsync(): AsyncGenerator<number> {
      yield 1;
      throw failure;
    }
    const wrapped = buildTracingWrapper({
      fn: halfwayAsync,
      tracer,
      caps: CAPS,
    });

    await expect(async () => {
      for await (const item of wrapped()) {
        void item;
      }
    }).rejects.toBe(failure);
    expect(attributesOf('halfwayAsync')['adk.fn.exc_type']).toBe('Error');
  });

  it('preserves the receiver of a wrapped prototype method', () => {
    class Counter {
      constructor(readonly start: number) {}
      add(amount: number): number {
        return this.start + amount;
      }
    }
    const wrapped = buildTracingWrapper({
      fn: Counter.prototype.add,
      tracer,
      caps: CAPS,
      ownerName: 'Counter',
    });
    Object.defineProperty(Counter.prototype, 'add', {value: wrapped});

    expect(new Counter(10).add(5)).toBe(15);
    expect(attributesOf('Counter.add')['adk.fn.arg.amount']).toBe('5');
  });

  it('names an anonymous function in the span', () => {
    const anonymous = buildTracingWrapper({
      fn: Object.defineProperty(
        function (): number {
          return 1;
        },
        'name',
        {value: ''},
      ),
      tracer,
      caps: CAPS,
    });

    expect(anonymous()).toBe(1);
    expect(attributesOf('anonymous')['adk.fn.return']).toBe('1');
  });
});

describe('safeRepr rendering', () => {
  it('renders each kind of value the table declares', () => {
    expect(safeRepr("it's", CAPS)).toBe("'it\\'s'");
    expect(safeRepr('a\\b', CAPS)).toBe("'a\\\\b'");
    expect(safeRepr(true, CAPS)).toBe('true');
    expect(safeRepr(null, CAPS)).toBe('null');
    expect(safeRepr(undefined, CAPS)).toBe('undefined');
    expect(safeRepr(7n, CAPS)).toBe('7');
    expect(safeRepr(Symbol('s'), CAPS)).toBe('Symbol(s)');
    expect(safeRepr([1, 2], CAPS)).toBe('[1, 2]');
    expect(safeRepr(new Set([1, 2]), CAPS)).toBe('Set(2) {1, 2}');
    expect(safeRepr(new Map([['k', 1]]), CAPS)).toBe("Map(1) {'k' => 1}");
    expect(safeRepr({a: 1, b: 'x'}, CAPS)).toBe("{a: 1, b: 'x'}");
    expect(safeRepr(Object.create(null), CAPS)).toBe('{}');
    expect(safeRepr(moduleLevelFn, CAPS)).toBe('<Function moduleLevelFn>');
    expect(safeRepr(new RangeError('bad'), CAPS)).toBe("RangeError('bad')");
  });

  it('renders a non-string Map key without applying the name rules', () => {
    expect(safeRepr(new Map([[1, 'v']]), CAPS)).toBe("Map(1) {1 => 'v'}");
  });

  it('names the masked value even when it is absent or prototype-less', () => {
    expect(safeRepr({token: null}, CAPS)).toBe('{token: <Null>}');
    expect(safeRepr({token: undefined}, CAPS)).toBe('{token: <Undefined>}');
    expect(safeRepr({token: Object.create(null)}, CAPS)).toBe(
      '{token: <Object>}',
    );
    // A prototype whose `constructor` is not callable names nothing.
    expect(safeRepr({token: Object.create({constructor: 42})}, CAPS)).toBe(
      '{token: <Object>}',
    );
  });

  it('renders a function with no name as anonymous', () => {
    const nameless = Object.defineProperty(
      function (): number {
        return 1;
      },
      'name',
      {value: ''},
    );

    expect(safeRepr(nameless, CAPS)).toBe('<Function anonymous>');
  });
});

describe('positionalParamNames source parsing', () => {
  it('refuses a class and a signature it cannot read plainly', () => {
    class Widget {
      render(a: number): number {
        return a;
      }
    }

    expect(positionalParamNames(Widget)).toEqual([]);
    expect(positionalParamNames(Widget.prototype.render)).toEqual(['a']);
  });

  it('names a parameter that carries a default, so the secret rule still fires', () => {
    function login(user: string, password = 'x'): string {
      void password;
      return user;
    }
    // A default holding a comma and a call must not split the token list.
    function connect(
      host: string,
      token: Record<string, number> = {a: 1, b: 2},
      port = Number(1),
    ): string {
      void token;
      void port;
      return host;
    }

    expect(positionalParamNames(login)).toEqual(['user', 'password']);
    expect(positionalParamNames(connect)).toEqual(['host', 'token', 'port']);
    expect(positionalParamNames((a = 1) => a)).toEqual(['a']);
  });

  it('reports a parameter with no readable name under its index', () => {
    function connect({host}: {host: string}, secret: string): string {
      void secret;
      return host;
    }

    // The destructured parameter loses only its own name, not its neighbour's.
    expect(positionalParamNames(connect)).toEqual(['arg0', 'secret']);
    expect(positionalParamNames(({a}: {a: number}) => a)).toEqual(['arg0']);
  });

  it('drops a secret an unnamed parameter would otherwise have recorded', () => {
    function login(user: string, password = 'x'): string {
      void password;
      return user;
    }
    function push(channel: string, ...credentials: string[]): string {
      void credentials;
      return channel;
    }

    buildTracingWrapper({fn: login, tracer, caps: CAPS})(
      'alice',
      SENTINEL_TOKEN,
    );
    buildTracingWrapper({fn: push, tracer, caps: CAPS})(
      'general',
      SENTINEL_TOKEN,
      SENTINEL_TOKEN,
    );

    expect(attributesOf('login')).toEqual({
      'adk.fn.arg.user': "'alice'",
      'adk.fn.return': "'alice'",
    });
    expect(attributesOf('push')).toEqual({
      'adk.fn.arg.channel': "'general'",
      'adk.fn.return': "'general'",
    });
  });

  it('names every argument a rest parameter collects', () => {
    function send(channel: string, ...parts: string[]): string {
      void parts;
      return channel;
    }

    buildTracingWrapper({fn: send, tracer, caps: CAPS})(
      'general',
      'first',
      'second',
    );

    expect(restParamName(send)).toBe('parts');
    // Every collected argument takes the rest parameter's name, which is what
    // lets a `...credentials` rest parameter mask all of them.
    expect(attributesOf('send')['adk.fn.arg.parts']).toBe("'second'");
  });

  it('names nothing for a rest parameter that is itself destructured', () => {
    function collect(...[first, second]: number[]): number {
      return first + second;
    }

    expect(restParamName(collect)).toBeUndefined();
    expect(positionalParamNames(collect)).toEqual([]);
  });

  it('preserves a property and the arity of the wrapped function', () => {
    function annotated(a: number, b: number): number {
      return a + b;
    }
    Object.assign(annotated, {schema: 'sum'});

    const wrapped = buildTracingWrapper({fn: annotated, tracer, caps: CAPS});

    expect(wrapped.length).toBe(2);
    expect(Object.assign({}, wrapped)).toMatchObject({schema: 'sum'});
  });

  it('keeps its place through a default string holding a comma and a quote', () => {
    // The default carries a comma, so a scanner that does not track string
    // literals splits the token list inside it; the escaped quote then keeps
    // it lost. Either way the next parameter loses the name the credential
    // rule keys off, so this pins both halves of the scan.
    function greet(greeting = 'say "hi", it\'s me', token: string): string {
      void token;
      return greeting;
    }

    expect(positionalParamNames(greet)).toEqual(['greeting', 'token']);
  });

  it('reads an arrow that declares its one parameter without parentheses', () => {
    // Prettier writes `(x) => x` here, so the source a project using
    // `arrowParens: "avoid"` would emit is supplied directly.
    const spy = vi
      .spyOn(Function.prototype, 'toString')
      .mockReturnValue('value => value * 2');
    try {
      expect(positionalParamNames(syncShape)).toEqual(['value']);

      spy.mockReturnValue('something the parser cannot read');
      expect(positionalParamNames(syncShape)).toEqual([]);

      // A parameter list that never closes names nothing at all.
      spy.mockReturnValue('function truncated(a, b');
      expect(positionalParamNames(syncShape)).toEqual([]);
      expect(restParamName(syncShape)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('recordIoOnSpan filtering', () => {
  it('drops a secret-named pair a caller supplied itself', () => {
    const span = tracer.startSpan('record_io_filters');

    recordIoOnSpan({
      span,
      pairs: [
        {name: 'token', value: `'${SENTINEL_TOKEN}'`},
        {name: 'user', value: "'alice'"},
      ],
      result: 'ok',
      error: undefined,
      caps: CAPS,
    });
    span.end();

    const attributes = attributesOf('record_io_filters');
    expect(attributes).not.toHaveProperty('adk.fn.arg.token');
    expect(attributes['adk.fn.arg.user']).toBe("'alice'");
  });
});
