/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/plugins/test_auto_tracing_plugin.py` @ `main`.
 *
 * Four reference tests are not ported. Two walk `__slots__`, which has no
 * JavaScript analogue; the behaviour under them is covered by the array and
 * Map walk tests here. One removes a module from `sys.modules` mid-iteration,
 * replaced by an owner whose property read throws. One matches a top-level
 * module name, which has no analogue either: the port walks the object graph
 * instead of a module registry.
 */

import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  AUTO_TRACING_WRAPPED,
  AuthCredentialTypes,
  AutoTracingPlugin,
  createCaps,
  safeRepr,
} from '@google/adk';

import {
  SENTINEL_TOKEN,
  attributesOf,
  buildGraph,
  contextFor,
  exporter,
  instrument,
  isWrapped,
  provider,
  sentinelCredential,
  spanNames,
  tracer,
} from './auto_tracing_test_helpers.js';

const CAPS = createCaps();

beforeEach(() => {
  exporter.reset();
});

afterAll(async () => {
  await provider.shutdown();
});

describe('AutoTracingPlugin instrumentation', () => {
  it('test_emits_span', async () => {
    const {graph} = await instrument({graph: buildGraph()});

    expect(graph.syncFn(7)).toBe(8);
    expect(await graph.asyncFn(4)).toBe(8);
    expect(graph.instance.method(5)).toBe(4);
    expect(await graph.instance.asyncMethod(5)).toBe(15);

    for (const name of [
      'syncFn',
      'asyncFn',
      'Fixture.method',
      'Fixture.asyncMethod',
    ]) {
      expect(spanNames()).toContain(name);
    }
  });

  it('test_records_io', async () => {
    const {graph} = await instrument({graph: buildGraph()});

    graph.syncFn(7);
    await graph.asyncFn(4);

    expect(attributesOf('syncFn')).toMatchObject({
      'adk.fn.arg.x': '7',
      'adk.fn.return': '8',
    });
    expect(attributesOf('asyncFn')).toMatchObject({'adk.fn.return': '8'});
  });

  it('test_repeat_instrument_is_idempotent', async () => {
    const {plugin, graph, invocationContext} = await instrument({
      graph: buildGraph(),
    });
    const first = {sync: graph.syncFn, async: graph.asyncFn};

    await plugin.beforeRunCallback({invocationContext});

    expect(graph.syncFn).toBe(first.sync);
    expect(graph.asyncFn).toBe(first.async);
  });

  it('test_repeat_instrument_does_not_rewrap', async () => {
    const {plugin, graph, invocationContext} = await instrument({
      graph: buildGraph(),
    });
    await plugin.beforeRunCallback({invocationContext});
    // A second plugin sees the same global marker and leaves the graph alone.
    const second = new AutoTracingPlugin({tracer});
    await second.beforeRunCallback({invocationContext});

    graph.syncFn(7);

    // A re-wrap would nest a second span of the same name inside the first.
    expect(spanNames().filter((name) => name === 'syncFn')).toEqual(['syncFn']);
  });

  it('test_wrapper_marker_is_true', async () => {
    const {graph} = await instrument({graph: buildGraph()});

    for (const fn of [graph.syncFn, graph.asyncFn]) {
      expect(
        Object.getOwnPropertyDescriptor(fn, AUTO_TRACING_WRAPPED),
      ).toMatchObject({value: true, enumerable: false});
    }
  });

  it('test_out_of_scope_module_is_not_instrumented', async () => {
    const outOfScope = {
      strayFn(): number {
        return 42;
      },
    };
    await instrument({graph: buildGraph()});

    outOfScope.strayFn();

    expect(isWrapped(outOfScope.strayFn)).toBe(false);
    expect(spanNames()).not.toContain('strayFn');
  });

  it('test_records_exception', async () => {
    class Kaboom extends Error {}
    const graph = {
      boom(): never {
        throw new Kaboom('kaboom');
      },
    };
    await instrument({graph});

    expect(() => graph.boom()).toThrow('kaboom');

    const attributes = attributesOf('boom');
    expect(attributes['adk.fn.exc_type']).toBe('Kaboom');
    expect(attributes['adk.fn.exc_repr']).toContain('kaboom');
  });

  it('test_walk_returns_quickly_on_none_agent', async () => {
    const plugin = new AutoTracingPlugin({tracer});

    await plugin.beforeRunCallback({invocationContext: await contextFor()});

    expect(spanNames()).toEqual([]);
  });

  it('test_add_agent_scope_picks_up_agent_package', async () => {
    const helper = {
      run(): number {
        return 99;
      },
    };
    const {graph} = await instrument({graph: {child: helper}});

    expect(graph.child.run()).toBe(99);

    expect(spanNames()).toContain('run');
  });

  it('reaches an object held in an array and one held in a Map', async () => {
    // Replaces the reference's two `__slots__` walk cases: the behaviour under
    // them is that the walk reaches a child object held on a public property.
    const inArray = {
      fromArray(): string {
        return 'a';
      },
    };
    const inMap = {
      fromMap(): string {
        return 'm';
      },
    };
    const inSet = {
      fromSet(): string {
        return 's';
      },
    };
    const {graph} = await instrument({
      graph: {
        list: [inArray],
        map: new Map([['key', inMap]]),
        set: new Set([inSet]),
      },
    });

    graph.list[0].fromArray();
    graph.map.get('key')?.fromMap();
    [...graph.set][0].fromSet();

    expect(spanNames()).toEqual(
      expect.arrayContaining(['fromArray', 'fromMap', 'fromSet']),
    );
  });

  it('test_add_agent_scope_does_not_fire_property_descriptors', async () => {
    const fired: string[] = [];
    const graph = {
      get expensive(): never {
        fired.push('expensive');
        throw new Error('should never be invoked during the scope walk');
      },
    };

    await instrument({graph});

    expect(fired).toEqual([]);
  });

  it('skips an owner whose property read throws without aborting the pass', async () => {
    // Replaces the reference's `sys.modules` mid-iteration test: there is no
    // module registry here, so the equivalent is an owner the walk cannot read.
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor(): never {
          throw new Error('no descriptors for you');
        },
        ownKeys(): string[] {
          return ['anything'];
        },
      },
    );
    const sibling = {
      survivor(): number {
        return 1;
      },
    };

    const {graph} = await instrument({graph: {hostile, sibling}});

    graph.sibling.survivor();
    expect(spanNames()).toContain('survivor');
  });

  it('test_signature_introspection_happens_once_per_wrap', async () => {
    const graph = buildGraph();
    const target = graph.syncFn;
    const toStringSpy = vi.spyOn(Function.prototype, 'toString');
    try {
      await instrument({graph});
      const afterWrap = toStringSpy.mock.contexts.filter(
        (receiver) => receiver === target,
      ).length;
      expect(afterWrap).toBeGreaterThan(0);

      for (let i = 0; i < 5; i++) {
        graph.syncFn(1);
      }

      expect(
        toStringSpy.mock.contexts.filter((receiver) => receiver === target)
          .length,
      ).toBe(afterWrap);
    } finally {
      toStringSpy.mockRestore();
    }
  });

  it('test_async_gen_caps_buffered_items', async () => {
    const cap = 3;
    const totalYields = 100;
    const graph = {
      async *producer(): AsyncGenerator<number> {
        for (let i = 0; i < totalYields; i++) {
          yield i;
        }
      },
    };
    await instrument({graph, maxRecordedYields: cap});

    const seen: number[] = [];
    for await (const item of graph.producer()) {
      seen.push(item);
    }

    expect(seen).toEqual([...Array(totalYields).keys()]);
    const rendered = attributesOf('producer')['adk.fn.return'];
    expect(rendered).toContain(`${totalYields} items yielded`);
    expect(rendered).toContain(`first ${cap}:`);
    expect(rendered).toContain(`+ ${totalYields - cap} more`);
  });

  it('test_sync_gen_caps_buffered_items', async () => {
    const cap = 2;
    const totalYields = 50;
    const graph = {
      *producer(): Generator<number> {
        for (let i = 0; i < totalYields; i++) {
          yield i;
        }
      },
    };
    await instrument({graph, maxRecordedYields: cap});

    expect([...graph.producer()]).toEqual([...Array(totalYields).keys()]);
    const rendered = attributesOf('producer')['adk.fn.return'];
    expect(rendered).toContain(`${totalYields} items yielded`);
    expect(rendered).toContain(`first ${cap}:`);
  });

  it('test_credential_return_is_redacted', async () => {
    const graph = {
      issueCredential(user: string): Record<string, unknown> {
        void user;
        return sentinelCredential();
      },
    };
    await instrument({graph});

    graph.issueCredential('alice');

    const attributes = attributesOf('issueCredential');
    expect(attributes['adk.fn.return']).toBe('<Object>');
    expect(JSON.stringify(attributes)).not.toContain(SENTINEL_TOKEN);
    // Ordinary arguments are still traced.
    expect(attributes['adk.fn.arg.user']).toBe("'alice'");
  });

  it('test_credential_named_args_are_not_recorded', async () => {
    const graph = {
      login(
        user: string,
        token: string,
        api_key: string,
        refresh_token: string,
      ): string {
        void token;
        void api_key;
        void refresh_token;
        return user;
      },
    };
    await instrument({graph});

    graph.login('alice', SENTINEL_TOKEN, SENTINEL_TOKEN, SENTINEL_TOKEN);

    const attributes = attributesOf('login');
    expect(attributes).not.toHaveProperty('adk.fn.arg.token');
    expect(attributes).not.toHaveProperty('adk.fn.arg.api_key');
    expect(attributes).not.toHaveProperty('adk.fn.arg.refresh_token');
    expect(JSON.stringify(attributes)).not.toContain(SENTINEL_TOKEN);
    // Ordinary arguments and returns are still traced.
    expect(attributes['adk.fn.arg.user']).toBe("'alice'");
    expect(attributes['adk.fn.return']).toBe("'alice'");
  });

  it('test_credential_yielded_by_generator_is_redacted', async () => {
    const graph = {
      *issueAll(user: string): Generator<Record<string, unknown>> {
        void user;
        yield {bundle: sentinelCredential()};
      },
    };
    await instrument({graph});

    expect([...graph.issueAll('alice')]).toHaveLength(1);

    const rendered = attributesOf('issueAll')['adk.fn.return'];
    expect(String(rendered)).not.toContain(SENTINEL_TOKEN);
    expect(rendered).toContain('1 items yielded');
    expect(rendered).toContain('{bundle: <Object>}');
  });
});

describe('AutoTracingPlugin credential redaction', () => {
  it('test_credential_field_of_default_repr_object_is_redacted', () => {
    // The field is deliberately not named like a credential, so only the
    // shape check can catch it.
    class Holder {
      readonly payload = sentinelCredential();
    }

    const rendered = safeRepr(new Holder(), CAPS);

    expect(rendered).not.toContain(SENTINEL_TOKEN);
    expect(rendered).toBe('<Holder fields={payload=<Object>}>');
  });

  it('test_credential_in_namedtuple_return_is_redacted', () => {
    // A plain object stands in for the reference's NamedTuple.
    const rendered = safeRepr(
      {payload: sentinelCredential(), wasExchanged: true},
      CAPS,
    );

    expect(rendered).not.toContain(SENTINEL_TOKEN);
    expect(rendered).toBe('{payload: <Object>, wasExchanged: true}');
  });

  it('test_credential_in_dict_return_is_redacted', () => {
    const rendered = safeRepr({alice: sentinelCredential()}, CAPS);

    expect(rendered).not.toContain(SENTINEL_TOKEN);
    expect(rendered).toBe('{alice: <Object>}');
  });

  it('test_credential_deeply_nested_is_redacted', () => {
    // object -> object -> object -> array -> array -> credential.
    const value = {
      envelope: {
        label: 'e1',
        sessions: {
          s1: {owner: 'alice', bundles: [[sentinelCredential()]]},
        },
      },
    };

    const rendered = safeRepr(value, CAPS);

    expect(rendered).not.toContain(SENTINEL_TOKEN);
    expect(rendered).toContain('<Object>');
    // The non-secret structure around it survives.
    expect(rendered).toContain("label: 'e1'");
    expect(rendered).toContain("owner: 'alice'");
  });

  it('test_credential_in_pydantic_field_is_redacted', () => {
    // A class instance stands in for the reference's pydantic model.
    class Wrapper {
      constructor(
        readonly label: string,
        readonly payload: unknown,
      ) {}
    }

    const rendered = safeRepr(new Wrapper('w', sentinelCredential()), CAPS);

    expect(rendered).not.toContain(SENTINEL_TOKEN);
    expect(rendered).toBe("<Wrapper fields={label='w', payload=<Object>}>");
  });

  it('test_credential_subclass_is_redacted', () => {
    class MyCredential {
      readonly authType = AuthCredentialTypes.OAUTH2;
      readonly oauth2 = {accessToken: SENTINEL_TOKEN};
    }

    expect(safeRepr([new MyCredential()], CAPS)).toBe('[<MyCredential>]');
  });

  it('test_secret_named_key_is_masked_by_name', () => {
    // A token response: no credential shape anywhere, only key names.
    const rendered = safeRepr(
      {access_token: SENTINEL_TOKEN, expires_in: 3600},
      CAPS,
    );

    expect(rendered).not.toContain(SENTINEL_TOKEN);
    expect(rendered).toBe('{access_token: <String>, expires_in: 3600}');
  });

  it('test_secret_behind_private_attr_forces_summary', () => {
    class Store {
      #secrets = {cred: sentinelCredential()};
      readonly name = 'store';
      toString(): string {
        return `Store(${JSON.stringify(this.#secrets)})`;
      }
    }
    class Legacy {
      readonly _hidden = sentinelCredential();
      readonly label = 'x';
    }

    // The custom toString would print the private state, so it is never used.
    expect(safeRepr(new Store(), CAPS)).toBe("<Store fields={name='store'}>");
    expect(safeRepr(new Legacy(), CAPS)).toBe("<Legacy fields={label='x'}>");
  });

  it('test_clean_values_render_exactly_like_repr', () => {
    class Session {
      constructor(
        readonly owner: string,
        readonly counts: readonly number[],
      ) {}
    }

    expect(safeRepr({a: [1, 2], b: ['x']}, CAPS)).toBe("{a: [1, 2], b: ['x']}");
    expect(safeRepr([{n: null}, new Set([1, 2])], CAPS)).toBe(
      '[{n: null}, Set(2) {1, 2}]',
    );
    expect(safeRepr(new Session('alice', [1, 2]), CAPS)).toBe(
      "<Session fields={owner='alice', counts=[1, 2]}>",
    );
  });

  it('test_cyclic_and_deep_values_are_bounded', () => {
    const cycle: Record<string, unknown> = {cred: sentinelCredential()};
    cycle['self'] = cycle;

    const cyclic = safeRepr(cycle, CAPS);
    expect(cyclic).not.toContain(SENTINEL_TOKEN);
    expect(cyclic).toBe('{cred: <Object>, self: <Object ...>}');

    let deep: unknown = sentinelCredential();
    for (let i = 0; i < 200; i++) {
      deep = [deep];
    }

    const nested = safeRepr(deep, CAPS);
    expect(nested).not.toContain(SENTINEL_TOKEN);
    expect(nested).toContain('<Array ...>');
  });

  it('elides rather than rendering once the node budget runs out', () => {
    const wide = Array.from({length: 2000}, () => ({
      payload: sentinelCredential(),
    }));
    // A length cap wide enough that it cannot hide the elision.
    const roomy = createCaps({maxReprLen: 1_000_000});

    const rendered = safeRepr(wide, roomy);

    expect(rendered).not.toContain(SENTINEL_TOKEN);
    expect(rendered).toContain('{payload: <Object>}');
    expect(rendered).toContain('<Object ...>');
  });

  it('test_credential_arg_name_matching', () => {
    const cases: ReadonlyArray<readonly [string, boolean]> = [
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

    for (const [name, masked] of cases) {
      const rendered = safeRepr({[name]: SENTINEL_TOKEN, marker: 1}, CAPS);
      expect(rendered).toBe(
        masked
          ? `{${name}: <String>, marker: 1}`
          : `{${name}: '${SENTINEL_TOKEN}', marker: 1}`,
      );
    }
  });

  it('test_failed_redaction_walk_elides_rather_than_raising', () => {
    class AngrySet extends Set<unknown> {
      override [Symbol.iterator](): SetIterator<unknown> {
        throw new Error('boom');
      }
    }

    const rendered = safeRepr(new AngrySet([sentinelCredential()]), CAPS);

    expect(rendered).not.toContain(SENTINEL_TOKEN);
    expect(rendered).toBe('<AngrySet ...>');
  });

  it('test_summarize_default', () => {
    class Slotted {
      readonly a = 1;
      readonly b = 'x';
    }
    class Bare {}

    expect(safeRepr(new Slotted(), CAPS)).toBe("<Slotted fields={a=1, b='x'}>");
    expect(safeRepr(new Bare(), CAPS)).toBe('<Bare>');
  });
});
