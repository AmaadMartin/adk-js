/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behaviour of `AutoTracingPlugin` that has no counterpart in
 * `google/adk-python`, kept apart so the ported test files stay legible.
 *
 * Most of it exists because JavaScript has no module registry to scan: the
 * plugin walks an object graph and rebinds properties, which raises questions
 * (intrinsic prototypes, frozen objects, property flags) that the reference
 * never has to answer.
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  AutoTracingPlugin,
  AutoTracingPluginOptions,
  BaseAgent,
  Event,
  InvocationContext,
  LogLevel,
  PluginManager,
  createSession,
  setLogLevel,
} from '@google/adk';
import {Attributes, ProxyTracerProvider} from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {afterAll, beforeEach, describe, expect, it} from 'vitest';
import {
  Caps,
  DEFAULT_MAX_RECORDED_YIELDS,
  DEFAULT_MAX_REPR_LEN,
  TracedFunction,
  isCredentialArgName,
  isTracingWrapper,
  positionalParamNames,
  safeRepr,
} from '../../src/plugins/auto_tracing_helpers.js';

setLogLevel(LogLevel.ERROR);

const CAPS: Caps = {
  maxReprLen: DEFAULT_MAX_REPR_LEN,
  maxRecordedYields: DEFAULT_MAX_RECORDED_YIELDS,
};

const SENTINEL_TOKEN = 'sentinel-token-do-not-trace';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
const tracer = provider.getTracer('auto_tracing_js_test');

beforeEach(() => {
  exporter.reset();
});

afterAll(async () => {
  await provider.shutdown();
});

function attributesOf(name: string): Attributes {
  const spans = exporter.getFinishedSpans().filter((s) => s.name === name);
  expect(spans.map((s) => s.name)).toEqual([name]);
  return spans[0].attributes;
}

function invocationContextFor(agent?: BaseAgent): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-auto-tracing',
    session: createSession({id: 'session-1', appName: 'auto_tracing_test'}),
    pluginManager: new PluginManager(),
    agent,
  });
}

async function instrument(
  targets: readonly object[],
  options: AutoTracingPluginOptions = {},
): Promise<AutoTracingPlugin> {
  const plugin = new AutoTracingPlugin({
    tracer,
    extraTargets: targets,
    ...options,
  });
  await plugin.beforeRunCallback({invocationContext: invocationContextFor()});
  return plugin;
}

/** An agent that runs nothing, used only as a root for the walk. */
class FixtureAgent extends BaseAgent {
  constructor(
    name: string,
    readonly toolbox: object,
  ) {
    super({name});
  }

  protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {
    yield* [];
  }

  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    yield* [];
  }
}

describe('AutoTracingPlugin — construction', () => {
  it('defaults its name and its tracer', () => {
    const plugin = new AutoTracingPlugin();

    expect(plugin.name).toBe('AutoTracingPlugin');
  });

  it('takes a caller-supplied name', () => {
    expect(new AutoTracingPlugin({name: 'tracing'}).name).toBe('tracing');
  });
});

describe('AutoTracingPlugin — runtime safety', () => {
  it('never wraps an intrinsic prototype', async () => {
    const originals = {
      then: Promise.prototype.then,
      map: Array.prototype.map,
      hasOwnProperty: Object.prototype.hasOwnProperty,
      call: Function.prototype.call,
    };

    await instrument([
      {pending: Promise.resolve(1), list: [1, 2], plain: {}, fn(): void {}},
    ]);

    expect(Promise.prototype.then).toBe(originals.then);
    expect(Array.prototype.map).toBe(originals.map);
    expect(Object.prototype.hasOwnProperty).toBe(originals.hasOwnProperty);
    expect(Function.prototype.call).toBe(originals.call);
  });

  it('never wraps a class constructor', async () => {
    class Widget {
      constructor(readonly size: number) {}
    }
    const bag = {Widget};

    await instrument([bag]);

    expect(bag.Widget).toBe(Widget);
    expect(new bag.Widget(3).size).toBe(3);
  });

  it('keeps a wrapped prototype method non-enumerable', async () => {
    class Thing {
      doIt(): number {
        return 1;
      }
    }

    await instrument([new Thing()]);

    expect(isTracingWrapper(Thing.prototype.doIt)).toBe(true);
    expect(Object.keys(Thing.prototype)).toEqual([]);
  });

  it('skips a frozen object without throwing', async () => {
    const frozen = Object.freeze({
      fn(): number {
        return 1;
      },
    });

    await instrument([frozen]);

    expect(isTracingWrapper(frozen.fn)).toBe(false);
    expect(frozen.fn()).toBe(1);
  });

  it('skips a non-configurable property without throwing', async () => {
    const target: {fn?: TracedFunction} = {};
    const original = (): number => 1;
    Object.defineProperty(target, 'fn', {
      value: original,
      writable: false,
      configurable: false,
      enumerable: true,
    });

    await instrument([target]);

    expect(target.fn).toBe(original);
  });

  it('skips an intrinsic reached by value and visits a shared object once', async () => {
    const shared = {
      fn(): number {
        return 1;
      },
    };
    const mathMax = Math.max;

    await instrument([{math: Math, first: shared, second: shared}]);

    expect(Math.max).toBe(mathMax);
    expect(isTracingWrapper(shared.fn)).toBe(true);
  });

  it('leaves an underscored own function alone', async () => {
    const bag = {
      _hidden(): number {
        return 1;
      },
      visible(): number {
        return 2;
      },
    };

    await instrument([bag]);

    expect(isTracingWrapper(bag._hidden)).toBe(false);
    expect(isTracingWrapper(bag.visible)).toBe(true);
  });

  it('names a span by the function alone when the owner has no class', async () => {
    // Assigning an arrow to a property leaves it unnamed, so the function is
    // named explicitly; the owner is what this test drops.
    const prototype: {detached?: () => number} = Object.create(null);
    prototype.detached = function detached(): number {
      return 5;
    };
    const instance: {detached(): number} = Object.create(prototype);

    await instrument([instance]);
    instance.detached();

    expect(attributesOf('detached')['adk.fn.return']).toBe('5');
  });

  it('skips a hostile object and keeps instrumenting the rest', async () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error('no reflection');
        },
      },
    );
    const survivor = {
      stillWrapped(): number {
        return 1;
      },
    };

    await instrument([{hostile, survivor}]);

    expect(isTracingWrapper(survivor.stillWrapped)).toBe(true);
  });

  it('does nothing at all when the tracer will not record', async () => {
    const bag = {
      fn(): number {
        return 1;
      },
    };
    const plugin = new AutoTracingPlugin({
      tracer: new ProxyTracerProvider().getTracer('noop'),
      extraTargets: [bag],
    });

    await plugin.beforeRunCallback({
      invocationContext: invocationContextFor(),
    });

    expect(isTracingWrapper(bag.fn)).toBe(false);
  });
});

describe('AutoTracingPlugin — walk bounds and reach', () => {
  it('descends into arrays, Map values and Set members', async () => {
    const inArray = {
      fn(): string {
        return 'a';
      },
    };
    const inMap = {
      fn(): string {
        return 'm';
      },
    };
    const inSet = {
      fn(): string {
        return 's';
      },
    };

    await instrument([
      {
        list: [inArray],
        lookup: new Map([['k', inMap]]),
        members: new Set([inSet]),
      },
    ]);

    expect(isTracingWrapper(inArray.fn)).toBe(true);
    expect(isTracingWrapper(inMap.fn)).toBe(true);
    expect(isTracingWrapper(inSet.fn)).toBe(true);
  });

  it('stops at maxWalkDepth', async () => {
    const deepest = {
      fn(): number {
        return 4;
      },
    };
    const atLimit = {
      fn(): number {
        return 3;
      },
      child: deepest,
    };
    const root = {child: {child: {child: atLimit}}};

    await instrument([root], {maxWalkDepth: 3});

    expect(isTracingWrapper(atLimit.fn)).toBe(true);
    expect(isTracingWrapper(deepest.fn)).toBe(false);
  });

  it('stops a prototype chain that never repeats', async () => {
    // A proxy can hand back a fresh prototype every time, so the visited set
    // never matches it. Only the node budget ends this walk.
    const link = (): object => new Proxy({}, {getPrototypeOf: link});
    const survivor = {
      fn(): number {
        return 1;
      },
    };

    await instrument([survivor, link()]);

    expect(isTracingWrapper(survivor.fn)).toBe(true);
  });

  it('stops when the node budget runs out on a very wide graph', async () => {
    // The cap is an internal constant; this graph is comfortably wider.
    const wide = Array.from({length: 12000}, () => ({
      fn(): number {
        return 1;
      },
    }));

    await instrument([wide]);

    expect(isTracingWrapper(wide[0].fn)).toBe(true);
    expect(isTracingWrapper(wide[wide.length - 1].fn)).toBe(false);
  });

  it('instruments functions reachable from invocationContext.agent', async () => {
    const toolbox = {
      lookupCity(city: unknown): string {
        return `city:${String(city)}`;
      },
    };
    const agent = new FixtureAgent('tracing_agent', toolbox);
    const plugin = new AutoTracingPlugin({tracer});

    await plugin.beforeRunCallback({
      invocationContext: invocationContextFor(agent),
    });
    toolbox.lookupCity('paris');

    expect(attributesOf('lookupCity')).toEqual({
      'adk.fn.arg.city': '"paris"',
      'adk.fn.return': '"city:paris"',
    });
  });

  it('reaches an extraTargets object the agent graph does not', async () => {
    const detached = {
      offGraph(): number {
        return 7;
      },
    };
    const agent = new FixtureAgent('detached_agent', {});
    const plugin = new AutoTracingPlugin({tracer, extraTargets: [detached]});

    await plugin.beforeRunCallback({
      invocationContext: invocationContextFor(agent),
    });
    detached.offGraph();

    expect(attributesOf('offGraph')['adk.fn.return']).toBe('7');
  });
});

describe('AutoTracingPlugin — wrapper shapes', () => {
  it('awaits a Promise-returning function that is not declared async', async () => {
    const bag = {
      delayed(x: unknown): Promise<number> {
        return new Promise((resolve) => {
          setTimeout(() => resolve(Number(x) + 1), 1);
        });
      },
    };
    await instrument([bag]);

    expect(await bag.delayed(1)).toBe(2);

    // Without awaiting inside the span this would render the Promise itself.
    expect(attributesOf('delayed')['adk.fn.return']).toBe('2');
  });

  it('records the rejection of a Promise-returning function', async () => {
    const bag = {
      failing(): Promise<number> {
        return Promise.reject(new TypeError('nope'));
      },
    };
    await instrument([bag]);

    await expect(bag.failing()).rejects.toThrow('nope');

    expect(attributesOf('failing')['adk.fn.exc_type']).toBe('TypeError');
  });

  it('records the failure of an async function', async () => {
    const bag = {
      async failing(): Promise<number> {
        throw new TypeError('async nope');
      },
    };
    await instrument([bag]);

    await expect(bag.failing()).rejects.toThrow('async nope');

    expect(attributesOf('failing')['adk.fn.exc_type']).toBe('TypeError');
  });

  it('ends the span of a generator a consumer abandons early', async () => {
    const bag = {
      *counter(): Generator<number> {
        for (let i = 0; i < 10; i++) {
          yield i;
        }
      },
    };
    await instrument([bag]);

    for (const item of bag.counter()) {
      if (item === 2) {
        break;
      }
    }

    expect(String(attributesOf('counter')['adk.fn.return'])).toContain(
      '3 items yielded',
    );
  });

  it('records the failure of a generator', async () => {
    const bag = {
      *failing(): Generator<number> {
        yield 1;
        throw new RangeError('mid-stream');
      },
    };
    await instrument([bag]);

    expect(() => [...bag.failing()]).toThrow('mid-stream');

    const attributes = attributesOf('failing');
    expect(attributes['adk.fn.exc_type']).toBe('RangeError');
  });

  it('awaits a thenable that is not a promise', async () => {
    const bag = {
      settleLater(): unknown {
        return {
          then(resolve: (value: number) => void): void {
            resolve(7);
          },
        };
      },
    };
    await instrument([bag]);

    expect(await bag.settleLater()).toBe(7);

    // The wrapper awaits the thenable inside the span, so the attribute holds
    // the settled value rather than the thenable itself.
    expect(attributesOf('settleLater')['adk.fn.return']).toBe('7');
  });

  it('ends the span of an async generator a consumer abandons early', async () => {
    const bag = {
      async *counter(): AsyncGenerator<number> {
        for (let i = 0; i < 10; i++) {
          yield i;
        }
      },
    };
    await instrument([bag]);

    for await (const item of bag.counter()) {
      if (item === 2) {
        break;
      }
    }

    expect(String(attributesOf('counter')['adk.fn.return'])).toContain(
      '3 items yielded',
    );
  });

  it('records the failure of an async generator', async () => {
    const bag = {
      async *failing(): AsyncGenerator<number> {
        yield 1;
        throw new RangeError('async mid-stream');
      },
    };
    await instrument([bag]);

    await expect(async () => {
      for await (const item of bag.failing()) {
        void item;
      }
    }).rejects.toThrow('async mid-stream');

    expect(attributesOf('failing')['adk.fn.exc_type']).toBe('RangeError');
  });

  it('preserves the wrapped function name, arity and receiver', async () => {
    const bag = {
      base: 10,
      addBase(x: unknown, y: unknown): number {
        return this.base + Number(x) + Number(y);
      },
    };
    await instrument([bag]);

    expect(bag.addBase(1, 2)).toBe(13);
    expect(bag.addBase.name).toBe('addBase');
    expect(bag.addBase.length).toBe(2);
  });
});

describe('AutoTracingPlugin — parameter names', () => {
  it('reads names from every function form', () => {
    // esbuild re-prints a TypeScript arrow with parentheses, so an
    // unparenthesised one has to be built at runtime. Minified user code,
    // which this plugin also wraps, is full of them.
    const bareArrow: unknown = new Function('return x => x').call(null);
    const cases: ReadonlyArray<[unknown, readonly string[]]> = [
      [(a: unknown, b: unknown) => [a, b], ['a', 'b']],
      [(a: unknown = 1) => a, ['a']],
      [(a: unknown, ...rest: unknown[]) => [a, rest], ['a']],
      [bareArrow, ['x']],
      [Math.max, []],
      [{}, []],
    ];

    for (const [fn, expected] of cases) {
      expect(positionalParamNames(fn)).toEqual(expected);
    }
  });

  it('gives a destructured parameter an index name', async () => {
    const bag = {
      unpack({city}: {city: string}): string {
        return city;
      },
    };
    await instrument([bag]);

    bag.unpack({city: 'paris'});

    expect(attributesOf('unpack')['adk.fn.arg.arg0']).toBe('{city: "paris"}');
  });

  it('names a parameter whose default value holds a bracket', () => {
    const withBracketDefault = (
      a: unknown = {b: 1},
      c: unknown = [2],
    ): void => {
      void a;
      void c;
    };

    expect(positionalParamNames(withBracketDefault)).toEqual(['a', 'c']);
  });
});

describe('AutoTracingPlugin — camelCase credential names', () => {
  it('recognises the camelCase spellings adk-js uses', () => {
    const cases: ReadonlyArray<[string, boolean]> = [
      ['apiKey', true],
      ['authConfig', true],
      ['authCredential', true],
      ['privateKey', true],
      ['refreshToken', true],
      ['clientSecret', true],
      ['serviceApiKey', true],
      ['sessionCookie', true],
      ['toolAuthConfig', true],
      ['authorizationUrl', false],
      ['tokenizer', false],
    ];

    for (const [name, expected] of cases) {
      expect(isCredentialArgName(name), name).toBe(expected);
    }
  });

  it('drops camelCase credential arguments from the span', async () => {
    const bag = {
      connect(
        endpoint: unknown,
        apiKey: unknown,
        authConfig: unknown,
        privateKey: unknown,
      ): unknown {
        void apiKey;
        void authConfig;
        void privateKey;
        return endpoint;
      },
    };
    await instrument([bag]);

    bag.connect(
      'https://example.test',
      SENTINEL_TOKEN,
      SENTINEL_TOKEN,
      SENTINEL_TOKEN,
    );

    const attributes = attributesOf('connect');
    expect(attributes).not.toHaveProperty('adk.fn.arg.apiKey');
    expect(attributes).not.toHaveProperty('adk.fn.arg.authConfig');
    expect(attributes).not.toHaveProperty('adk.fn.arg.privateKey');
    expect(JSON.stringify(attributes)).not.toContain(SENTINEL_TOKEN);
    expect(attributes['adk.fn.arg.endpoint']).toBe('"https://example.test"');
  });

  it('masks every secret field of an adk-js AuthCredential', () => {
    // adk-js declares AuthCredential and its parts as TypeScript interfaces,
    // so their values are plain objects at runtime and carry no constructor
    // name. The type arm of the check cannot see them; the field-name arm is
    // what protects them.
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      apiKey: SENTINEL_TOKEN,
      oauth2: {
        clientId: 'public-client-id',
        clientSecret: SENTINEL_TOKEN,
        accessToken: SENTINEL_TOKEN,
        refreshToken: SENTINEL_TOKEN,
        idToken: SENTINEL_TOKEN,
      },
      http: {
        scheme: 'bearer',
        credentials: {token: SENTINEL_TOKEN, password: SENTINEL_TOKEN},
      },
      serviceAccount: {
        serviceAccountCredential: {
          type: 'service_account',
          projectId: 'p',
          privateKeyId: 'k',
          privateKey: SENTINEL_TOKEN,
          clientEmail: 'a@b.test',
          clientId: 'c',
          authUri: 'https://example.test/auth',
          tokenUri: 'https://example.test/token',
          authProviderX509CertUrl: 'https://example.test/certs',
          clientX509CertUrl: 'https://example.test/cert',
          universeDomain: 'example.test',
        },
      },
    };

    const rendered = safeRepr(credential, CAPS);

    expect(rendered).not.toContain(SENTINEL_TOKEN);
    expect(rendered).toContain('apiKey: <String>');
    expect(rendered).toContain('clientId: "public-client-id"');
  });
});

describe('AutoTracingPlugin — rendering edge cases', () => {
  it('renders values that have no Python counterpart', () => {
    const symbol = Symbol('marker');
    const cases: ReadonlyArray<[unknown, string]> = [
      [undefined, 'undefined'],
      [null, 'null'],
      [10n, '10n'],
      [symbol, 'Symbol(marker)'],
      [function named(): void {}, '[Function: named]'],
      [new Date('2026-01-02T03:04:05.000Z'), '2026-01-02T03:04:05.000Z'],
      [/ab+c/gi, '/ab+c/gi'],
      [new TypeError('bad input'), 'TypeError: bad input'],
      [{'not-an-identifier': 1}, '{"not-an-identifier": 1}'],
      [Object.create(null), '{}'],
    ];

    for (const [value, expected] of cases) {
      expect(safeRepr(value, CAPS)).toBe(expected);
    }
  });

  it('masks a secret-named member whatever it holds', () => {
    const rendered = safeRepr(
      {
        apiKey: null,
        authConfig: undefined,
        privateKey: Object.create(null),
        keep: 1,
      },
      CAPS,
    );

    expect(rendered).toBe(
      '{apiKey: <null>, authConfig: <undefined>, privateKey: <object>, keep: 1}',
    );
  });

  it('skips an accessor property rather than firing it', () => {
    let fired = 0;
    const value = {
      get lazy(): number {
        fired++;
        return 1;
      },
      plain: 2,
    };

    expect(safeRepr(value, CAPS)).toBe('{plain: 2}');
    expect(fired).toBe(0);
  });

  it('stops walking a prototype chain that never ends', () => {
    // A proxy can report itself as its own prototype. Without the chain
    // bound, the credential-type check would spin here forever.
    const cyclic: object = new Proxy(
      {},
      {
        getPrototypeOf(): object {
          return cyclic;
        },
      },
    );

    expect(safeRepr(cyclic, CAPS)).toBe('<Object>');
  });

  it('renders an anonymous function without a name', () => {
    const anonymous = Object.defineProperty(() => 1, 'name', {value: ''});

    expect(safeRepr(anonymous, CAPS)).toBe('[Function (anonymous)]');
  });

  it('elides a value once the node budget runs out', () => {
    // Each object costs one node; the budget is an internal constant well
    // below this width. The length cap is lifted so the elision is visible
    // rather than truncated away.
    const wide = Array.from({length: 2000}, (_unused, index) => ({index}));
    const roomyCaps: Caps = {maxReprLen: 1000000, maxRecordedYields: 16};

    const rendered = safeRepr(wide, roomyCaps);

    expect(rendered).toContain('{index: 0}');
    expect(rendered).toContain('<Object ...>');
  });

  it('masks a credential held under a secret-named Map key', () => {
    const lookup = new Map<unknown, unknown>([
      ['apiKey', SENTINEL_TOKEN],
      [1, 'plain'],
    ]);

    const rendered = safeRepr(lookup, CAPS);

    expect(rendered).not.toContain(SENTINEL_TOKEN);
    expect(rendered).toBe('Map(2) {"apiKey" => <String>, 1 => "plain"}');
  });

  it('elides a value whose property access throws', () => {
    const hostile = new Proxy(
      {},
      {
        get(): never {
          throw new Error('no property access');
        },
      },
    );

    // Branding a value reads `Symbol.toStringTag`, so the trap fires. An
    // elision is the safe outcome: nothing says the value is free of secrets.
    expect(safeRepr(hostile, CAPS)).toBe('<object ...>');
  });
});
