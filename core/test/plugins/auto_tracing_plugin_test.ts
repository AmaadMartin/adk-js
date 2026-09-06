/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python`
 * `tests/unittests/plugins/test_auto_tracing_plugin.py`, at commit
 * `a119dd7751082dbbd9a65f71e359abdc2be659cc`. Each `it(...)` keeps the
 * original Python test name so a reviewer can find its counterpart.
 */

import {
  AutoTracingPlugin,
  AutoTracingPluginOptions,
  InvocationContext,
  LogLevel,
  PluginManager,
  createSession,
  setLogLevel,
} from '@google/adk';
import {Attributes} from '@opentelemetry/api';
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
  isCredentialArgName,
  isTracingWrapper,
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
const tracer = provider.getTracer('auto_tracing_plugin_test');

beforeEach(() => {
  exporter.reset();
});

afterAll(async () => {
  await provider.shutdown();
});

function spanNames(): string[] {
  return exporter.getFinishedSpans().map((span) => span.name);
}

/** Returns the attributes of the single finished span called `name`. */
function attributesOf(name: string): Attributes {
  const spans = exporter.getFinishedSpans().filter((s) => s.name === name);
  expect(spans.map((s) => s.name)).toEqual([name]);
  return spans[0].attributes;
}

/** Renders `attributes` so a test can assert no secret reached any of them. */
function renderedAttributes(attributes: Attributes): string {
  return JSON.stringify(attributes);
}

function emptyInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-auto-tracing',
    session: createSession({id: 'session-1', appName: 'auto_tracing_test'}),
    pluginManager: new PluginManager(),
  });
}

/** Instruments `targets` and returns the plugin, so a test can run it again. */
async function instrument(
  targets: readonly object[],
  options: AutoTracingPluginOptions = {},
): Promise<AutoTracingPlugin> {
  const plugin = new AutoTracingPlugin({
    tracer,
    extraTargets: targets,
    ...options,
  });
  await plugin.beforeRunCallback({invocationContext: emptyInvocationContext()});
  return plugin;
}

/**
 * A credential type recognised by name, matching the reference matching
 * `AuthCredential` over the MRO. Its field is deliberately not named like a
 * secret, so only the type arm of the check can catch it.
 */
class AuthCredential {
  constructor(readonly payload: string) {}
}

function sentinelCredential(): AuthCredential {
  return new AuthCredential(SENTINEL_TOKEN);
}

/** The reference's module-level `sync_fn`, `async_fn` and class `C`. */
function buildFixtures() {
  class Holder {
    method(x: unknown): number {
      return Number(x) - 1;
    }
    async asyncMethod(x: unknown): Promise<number> {
      return Number(x) + 10;
    }
  }
  return {
    syncFn(x: unknown): number {
      return Number(x) + 1;
    },
    async asyncFn(x: unknown): Promise<number> {
      return Number(x) * 2;
    },
    holder: new Holder(),
  };
}

describe('AutoTracingPlugin — instrumentation', () => {
  it('test_emits_span', async () => {
    const bag = buildFixtures();
    await instrument([bag]);

    bag.syncFn(7);
    await bag.asyncFn(4);
    bag.holder.method(5);
    await bag.holder.asyncMethod(5);

    expect(spanNames().sort()).toEqual([
      'Holder.asyncMethod',
      'Holder.method',
      'asyncFn',
      'syncFn',
    ]);
  });

  it('test_records_io', async () => {
    const bag = buildFixtures();
    await instrument([bag]);

    bag.syncFn(7);
    await bag.asyncFn(4);

    expect(attributesOf('syncFn')).toEqual({
      'adk.fn.arg.x': '7',
      'adk.fn.return': '8',
    });
    expect(attributesOf('asyncFn')['adk.fn.return']).toBe('8');
  });

  it('test_repeat_instrument_is_idempotent', async () => {
    const bag = buildFixtures();
    const plugin = await instrument([bag]);
    const firstSync = bag.syncFn;
    const firstAsync = bag.asyncFn;

    await plugin.beforeRunCallback({
      invocationContext: emptyInvocationContext(),
    });

    expect(bag.syncFn).toBe(firstSync);
    expect(bag.asyncFn).toBe(firstAsync);
  });

  it('test_wrapper_marker_is_true', async () => {
    const bag = buildFixtures();

    await instrument([bag]);

    expect(isTracingWrapper(bag.syncFn)).toBe(true);
    expect(isTracingWrapper(bag.asyncFn)).toBe(true);
  });

  it('test_repeat_instrument_does_not_rewrap', async () => {
    const bag = buildFixtures();
    const plugin = await instrument([bag]);

    await plugin.beforeRunCallback({
      invocationContext: emptyInvocationContext(),
    });
    exporter.reset();
    bag.syncFn(1);

    // A second wrapper around the first would emit a second, nested span.
    expect(spanNames()).toEqual(['syncFn']);
  });

  it('test_records_exception', async () => {
    const bag = {
      boom(): number {
        throw new RangeError('kaboom');
      },
    };
    await instrument([bag]);

    expect(() => bag.boom()).toThrow('kaboom');

    const attributes = attributesOf('boom');
    expect(attributes['adk.fn.exc_type']).toBe('RangeError');
    expect(String(attributes['adk.fn.exc_repr'])).toContain('kaboom');
  });

  it('test_walk_returns_quickly_on_none_agent', async () => {
    const plugin = new AutoTracingPlugin({tracer});

    await plugin.beforeRunCallback({
      invocationContext: emptyInvocationContext(),
    });

    expect(spanNames()).toEqual([]);
  });

  it('test_add_agent_scope_does_not_fire_property_descriptors', async () => {
    const fired: string[] = [];
    const target = {
      get expensive(): number {
        fired.push('expensive');
        throw new Error('should never be invoked during scope walk');
      },
      reachable(): number {
        return 1;
      },
    };

    await instrument([target]);

    expect(fired).toEqual([]);
    expect(isTracingWrapper(target.reachable)).toBe(true);
  });

  it('test_signature_introspection_happens_once_per_wrap', async () => {
    const bag = buildFixtures();
    await instrument([bag]);
    const originalToString = Function.prototype.toString;
    let sourceReads = 0;
    Function.prototype.toString = function (this: unknown): string {
      sourceReads++;
      return originalToString.call(this);
    };

    try {
      for (let i = 0; i < 5; i++) {
        bag.syncFn(1);
        await bag.asyncFn(1);
      }
    } finally {
      Function.prototype.toString = originalToString;
    }

    expect(sourceReads).toBe(0);
  });
});

describe('AutoTracingPlugin — generator sampling', () => {
  it('test_async_gen_caps_buffered_items', async () => {
    const cap = 3;
    const totalYields = 100;
    const bag = {
      async *producer(): AsyncGenerator<number> {
        for (let i = 0; i < totalYields; i++) {
          yield i;
        }
      },
    };
    await instrument([bag], {maxRecordedYields: cap});

    const seen: number[] = [];
    for await (const item of bag.producer()) {
      seen.push(item);
    }

    expect(seen).toEqual([...Array(totalYields).keys()]);
    const rendered = String(attributesOf('producer')['adk.fn.return']);
    expect(rendered).toContain(`${totalYields} items yielded`);
    expect(rendered).toContain(`first ${cap}:`);
    expect(rendered).toContain(`+ ${totalYields - cap} more`);
  });

  it('samples DEFAULT_MAX_RECORDED_YIELDS items when no cap is given', async () => {
    const totalYields = DEFAULT_MAX_RECORDED_YIELDS + 4;
    const bag = {
      *unconfigured(): Generator<number> {
        for (let i = 0; i < totalYields; i++) {
          yield i;
        }
      },
    };
    await instrument([bag]);

    expect([...bag.unconfigured()]).toHaveLength(totalYields);

    const rendered = String(attributesOf('unconfigured')['adk.fn.return']);
    expect(rendered).toContain(`first ${DEFAULT_MAX_RECORDED_YIELDS}:`);
    expect(rendered).toContain('+ 4 more');
  });

  it('test_sync_gen_caps_buffered_items', async () => {
    const cap = 2;
    const totalYields = 50;
    const bag = {
      *producer(): Generator<number> {
        for (let i = 0; i < totalYields; i++) {
          yield i;
        }
      },
    };
    await instrument([bag], {maxRecordedYields: cap});

    expect([...bag.producer()]).toEqual([...Array(totalYields).keys()]);

    const rendered = String(attributesOf('producer')['adk.fn.return']);
    expect(rendered).toContain(`${totalYields} items yielded`);
    expect(rendered).toContain(`first ${cap}:`);
  });
});

describe('AutoTracingPlugin — value rendering', () => {
  it('test_summarize_default', () => {
    class Slotted {
      readonly a = 1;
      readonly b = 'x';
    }
    class Bare {}

    expect(safeRepr(new Slotted(), CAPS)).toBe('<Slotted fields={a=1, b="x"}>');
    expect(safeRepr(new Bare(), CAPS)).toBe('<Bare>');
  });

  it('test_clean_values_render_exactly_like_repr', () => {
    // JavaScript has no `repr`, so this pins the exact rendering instead: a
    // value with no secret in it carries no masking marker.
    class Session {
      constructor(
        readonly owner: string,
        readonly creds: readonly unknown[],
      ) {}
    }
    const cases: ReadonlyArray<[unknown, string]> = [
      [{a: [1, 2], b: ['x']}, '{a: [1, 2], b: ["x"]}'],
      [[{n: null}, new Set([1, 2])], '[{n: null}, Set(2) {1, 2}]'],
      [new Set([7]), 'Set(1) {7}'],
      [
        new Session('alice', [1, 2]),
        '<Session fields={owner="alice", creds=[1, 2]}>',
      ],
      [new Map([['k', 1]]), 'Map(1) {"k" => 1}'],
    ];

    for (const [value, expected] of cases) {
      expect(safeRepr(value, CAPS)).toBe(expected);
    }
  });

  it('test_cyclic_and_deep_values_are_bounded', () => {
    const cycle: Record<string, unknown> = {cred: sentinelCredential()};
    cycle['self'] = cycle;

    const cycleRendered = safeRepr(cycle, CAPS);
    expect(cycleRendered).not.toContain(SENTINEL_TOKEN);
    expect(cycleRendered).toContain('<Object ...>');

    let deep: unknown = sentinelCredential();
    for (let i = 0; i < 200; i++) {
      deep = [deep];
    }
    const deepRendered = safeRepr(deep, CAPS);
    expect(deepRendered).not.toContain(SENTINEL_TOKEN);
    expect(deepRendered).toContain('<Array ...>');
  });

  it('test_failed_redaction_walk_elides_rather_than_raising', () => {
    class AngryBag {
      readonly cred = sentinelCredential();
    }
    const angry = new Proxy(new AngryBag(), {
      ownKeys(): never {
        throw new Error('boom');
      },
    });

    expect(safeRepr(angry, CAPS)).toBe('<AngryBag ...>');
  });
});

describe('AutoTracingPlugin — credential masking', () => {
  it('test_credential_return_is_redacted', async () => {
    const bag = {
      issueCredential(user: unknown): AuthCredential {
        void user;
        return sentinelCredential();
      },
    };
    await instrument([bag]);

    bag.issueCredential('alice');

    const attributes = attributesOf('issueCredential');
    expect(attributes['adk.fn.return']).toBe('<AuthCredential>');
    expect(renderedAttributes(attributes)).not.toContain(SENTINEL_TOKEN);
    // Ordinary args are still traced.
    expect(attributes['adk.fn.arg.user']).toBe('"alice"');
  });

  it('test_credential_named_args_are_not_recorded', async () => {
    const bag = {
      login(
        user: unknown,
        token: unknown,
        apiKey: unknown,
        refreshToken: unknown,
      ): unknown {
        void token;
        void apiKey;
        void refreshToken;
        return user;
      },
    };
    await instrument([bag]);

    bag.login('alice', SENTINEL_TOKEN, SENTINEL_TOKEN, SENTINEL_TOKEN);

    const attributes = attributesOf('login');
    expect(attributes).not.toHaveProperty('adk.fn.arg.token');
    expect(attributes).not.toHaveProperty('adk.fn.arg.apiKey');
    expect(attributes).not.toHaveProperty('adk.fn.arg.refreshToken');
    expect(renderedAttributes(attributes)).not.toContain(SENTINEL_TOKEN);
    // Ordinary args and returns are still traced.
    expect(attributes['adk.fn.arg.user']).toBe('"alice"');
    expect(attributes['adk.fn.return']).toBe('"alice"');
  });

  it('test_credential_field_of_default_repr_object_is_redacted', () => {
    // The field is deliberately not named like a credential, so only the type
    // check can catch it.
    class Holder {
      readonly payload = sentinelCredential();
    }

    const rendered = safeRepr(new Holder(), CAPS);

    expect(rendered).not.toContain(SENTINEL_TOKEN);
    expect(rendered).toBe('<Holder fields={payload=<AuthCredential>}>');
  });

  it('test_credential_in_namedtuple_return_is_redacted', async () => {
    // A Python NamedTuple has no JavaScript counterpart; the nearest shape is
    // a class instance with the same fields.
    class ExchangeResult {
      constructor(
        readonly credential: AuthCredential,
        readonly wasExchanged: boolean,
      ) {}
    }
    const bag = {
      exchange(user: unknown): ExchangeResult {
        void user;
        return new ExchangeResult(sentinelCredential(), true);
      },
    };
    await instrument([bag]);

    bag.exchange('alice');

    const attributes = attributesOf('exchange');
    expect(renderedAttributes(attributes)).not.toContain(SENTINEL_TOKEN);
    expect(attributes['adk.fn.return']).toBe(
      '<ExchangeResult fields={credential=<AuthCredential>, wasExchanged=true}>',
    );
  });

  it('test_credential_in_dict_return_is_redacted', async () => {
    const bag = {
      loadBucket(user: unknown): Record<string, AuthCredential> {
        return {[String(user)]: sentinelCredential()};
      },
    };
    await instrument([bag]);

    bag.loadBucket('alice');

    const attributes = attributesOf('loadBucket');
    expect(renderedAttributes(attributes)).not.toContain(SENTINEL_TOKEN);
    expect(attributes['adk.fn.return']).toBe('{alice: <AuthCredential>}');
  });

  it('test_credential_deeply_nested_is_redacted', () => {
    class Session {
      constructor(
        readonly owner: string,
        readonly creds: readonly unknown[],
      ) {}
    }
    class Envelope {
      constructor(
        readonly label: string,
        readonly sessions: Record<string, Session>,
      ) {}
    }
    // object -> class -> object -> class -> array -> array -> credential.
    const value = {
      envelope: new Envelope('e1', {
        s1: new Session('alice', [[sentinelCredential()]]),
      }),
    };

    const rendered = safeRepr(value, CAPS);

    expect(rendered).not.toContain(SENTINEL_TOKEN);
    expect(rendered).toContain('<AuthCredential>');
    // Non-secret structure around it survives.
    expect(rendered).toContain('label="e1"');
    expect(rendered).toContain('owner="alice"');
  });

  it('test_credential_in_pydantic_field_is_redacted', () => {
    // A pydantic model has no JavaScript counterpart; the nearest shape is a
    // class instance with declared fields.
    class Wrapper {
      constructor(
        readonly label: string,
        readonly payload: unknown,
      ) {}
    }

    const rendered = safeRepr(new Wrapper('w', sentinelCredential()), CAPS);

    expect(rendered).not.toContain(SENTINEL_TOKEN);
    expect(rendered).toBe(
      '<Wrapper fields={label="w", payload=<AuthCredential>}>',
    );
  });

  it('test_credential_subclass_is_redacted', () => {
    class MyCredential extends AuthCredential {}

    expect(safeRepr([new MyCredential(SENTINEL_TOKEN)], CAPS)).toBe(
      '[<MyCredential>]',
    );
  });

  it('test_secret_named_key_is_masked_by_name', () => {
    // A token-response object: no credential type anywhere, only key names.
    const rendered = safeRepr(
      {access_token: SENTINEL_TOKEN, expires_in: 3600},
      CAPS,
    );

    expect(rendered).not.toContain(SENTINEL_TOKEN);
    expect(rendered).toBe('{access_token: <String>, expires_in: 3600}');
  });

  it('test_secret_behind_private_attr_forces_summary', () => {
    class Store {
      // Underscored on purpose: the renderer treats a leading underscore as
      // private state and must never print it.
      readonly _value = {cred: sentinelCredential()};
      readonly name = 'store';
    }

    const rendered = safeRepr(new Store(), CAPS);

    expect(rendered).not.toContain(SENTINEL_TOKEN);
    expect(rendered).toBe('<Store fields={name="store"}>');
  });

  it('test_credential_yielded_by_generator_is_redacted', async () => {
    const bag = {
      *issueAll(user: unknown): Generator<Record<string, AuthCredential>> {
        void user;
        yield {bundle: sentinelCredential()};
      },
    };
    await instrument([bag]);

    expect([...bag.issueAll('alice')]).toHaveLength(1);

    const attributes = attributesOf('issueAll');
    const rendered = String(attributes['adk.fn.return']);
    expect(renderedAttributes(attributes)).not.toContain(SENTINEL_TOKEN);
    expect(rendered).toContain('1 items yielded');
    expect(rendered).toContain('{bundle: <AuthCredential>}');
  });

  it('test_credential_arg_name_matching', () => {
    const cases: ReadonlyArray<[string, boolean]> = [
      ['token', true],
      ['api_key', true],
      ['refresh_token', true],
      ['CLIENT_SECRET', true],
      ['user_token_count', false],
      ['tokenizer', false],
      ['secretary', false],
      ['authorization', true],
      ['cookie', true],
      ['cookies', true],
      ['private_key', true],
      ['service_account_private_key', true],
      ['custom_authorization', true],
      ['session_cookie', true],
      ['session_cookies', true],
      ['tool_auth_config', true],
      ['authorization_url', false],
      ['cookiecutter', false],
    ];

    for (const [name, expected] of cases) {
      expect(isCredentialArgName(name), name).toBe(expected);
    }
  });
});
