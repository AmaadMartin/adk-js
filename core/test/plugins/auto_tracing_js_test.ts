/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the behaviour that is specific to the JavaScript port of
 * `AutoTracingPlugin`, kept apart so that the tests ported from adk-python
 * stay legible as a set.
 */

import {trace} from '@opentelemetry/api';
import {afterAll, beforeEach, describe, expect, it} from 'vitest';

import {AutoTracingPlugin, createCaps, safeRepr} from '@google/adk';

import {
  FixtureAgent,
  SENTINEL_TOKEN,
  attributesOf,
  buildGraph,
  contextFor,
  exporter,
  instrument,
  isWrapped,
  provider,
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

describe('AutoTracingPlugin on JavaScript shapes', () => {
  it('records the partial sample when a consumer breaks out of a generator', async () => {
    const graph = {
      *counter(): Generator<number> {
        for (let i = 0; i < 100; i++) {
          yield i;
        }
      },
    };
    await instrument({graph, maxRecordedYields: 2});

    for (const item of graph.counter()) {
      if (item === 3) {
        break;
      }
    }

    // Breaking calls the generator's `return()`, which is the JavaScript
    // shape of the reference's GeneratorExit path.
    expect(attributesOf('counter')['adk.fn.return']).toBe(
      '<generator: 4 items yielded; first 2: [0, 1] ... + 2 more>',
    );
  });

  it('instruments an object the agent graph does not reach via extraTargets', async () => {
    const unreachable = {
      orphan(): number {
        return 1;
      },
    };

    await instrument({graph: buildGraph(), extraTargets: [unreachable]});

    expect(unreachable.orphan()).toBe(1);
    expect(spanNames()).toContain('orphan');
  });

  it('skips a non-writable property and carries on with the rest', async () => {
    const graph = {
      frozen(): number {
        return 1;
      },
      sibling: {
        survivor(): number {
          return 2;
        },
      },
    };
    Object.defineProperty(graph, 'frozen', {
      writable: false,
      configurable: false,
    });

    await instrument({graph});

    expect(isWrapped(graph.frozen)).toBe(false);
    expect(graph.sibling.survivor()).toBe(2);
    expect(spanNames()).toContain('survivor');
  });

  it('stops the walk once the node budget runs out', async () => {
    const near = {
      closeEnough(): number {
        return 1;
      },
    };
    const late = {
      tooFar(): number {
        return 2;
      },
    };
    const filler: object[] = Array.from({length: 12_000}, () => ({}));

    await instrument({graph: {near, filler: [...filler, late]}});

    expect(isWrapped(near.closeEnough)).toBe(true);
    expect(isWrapped(late.tooFar)).toBe(false);
  });

  it('stops descending at maxWalkDepth', async () => {
    const deep = {
      far(): number {
        return 1;
      },
    };
    const shallow = {
      near(): number {
        return 2;
      },
    };

    // The graph itself sits at depth 0, so `deep` is at depth 3.
    await instrument({graph: {shallow, a: {b: {c: deep}}}, maxWalkDepth: 2});

    expect(isWrapped(shallow.near)).toBe(true);
    expect(isWrapped(deep.far)).toBe(false);
  });

  it('records a destructured options argument as arg0 with its secrets masked', async () => {
    const graph = {
      connect({host, apiKey}: {host: string; apiKey: string}): string {
        void apiKey;
        return host;
      },
    };
    await instrument({graph});

    graph.connect({host: 'example', apiKey: SENTINEL_TOKEN});

    const attributes = attributesOf('connect');
    // Destructuring yields no parameter names, so the whole object is arg0.
    expect(attributes['adk.fn.arg.arg0']).toBe(
      "{host: 'example', apiKey: <String>}",
    );
    expect(JSON.stringify(attributes)).not.toContain(SENTINEL_TOKEN);
  });

  it('never wraps a method of a built-in prototype', async () => {
    class AppError extends Error {
      hint(): string {
        return 'try again';
      }
    }
    const graph = {
      failure: new AppError('held'),
      pending: Promise.resolve(1),
      when: new Date(0),
    };

    await instrument({graph});

    expect(isWrapped(Error.prototype.toString)).toBe(false);
    expect(isWrapped(Promise.prototype.then)).toBe(false);
    expect(isWrapped(Date.prototype.getTime)).toBe(false);
    expect(isWrapped(Object.prototype.hasOwnProperty)).toBe(false);
    // The stop set blocks the built-ins only, not the subclass above them.
    expect(isWrapped(AppError.prototype.hint)).toBe(true);
  });

  it('does not wrap a class constructor held on the graph', async () => {
    class Widget {
      render(): string {
        return 'w';
      }
    }
    const graph = {Widget};

    await instrument({graph});

    expect(isWrapped(graph.Widget)).toBe(false);
    expect(new graph.Widget().render()).toBe('w');
    // Instrumenting a class the graph merely holds is out of scope: only the
    // prototypes of reachable instances are walked.
    expect(isWrapped(Widget.prototype.render)).toBe(false);
  });

  it('leaves a symbol-keyed method alone', async () => {
    const key = Symbol('run');
    const graph = {
      [key](): number {
        return 1;
      },
      plain(): number {
        return 2;
      },
    };

    await instrument({graph});

    expect(isWrapped(graph[key])).toBe(false);
    expect(isWrapped(graph.plain)).toBe(true);
  });

  it('instruments nothing when the tracer will not record', async () => {
    const graph = buildGraph();
    // No global tracer provider is registered, so the API hands back a tracer
    // that never records.
    const plugin = new AutoTracingPlugin({
      tracer: trace.getTracer('no-provider-registered'),
    });

    await plugin.beforeRunCallback({
      invocationContext: await contextFor(new FixtureAgent(graph)),
    });

    expect(isWrapped(graph.syncFn)).toBe(false);
    expect(graph.syncFn(1)).toBe(2);
  });

  it('takes its name and its rendering cap from the options', async () => {
    expect(new AutoTracingPlugin().name).toBe('AutoTracingPlugin');
    expect(new AutoTracingPlugin({name: 'custom', tracer}).name).toBe('custom');

    const graph = {
      echo(text: string): string {
        return text;
      },
    };
    await instrument({graph, maxReprLen: 5});

    graph.echo('y'.repeat(10));

    expect(attributesOf('echo')['adk.fn.arg.text']).toBe(
      "'yyyy...[7 more chars]",
    );
  });

  it('masks a camel-cased secret field name', () => {
    for (const name of [
      'accessToken',
      'apiKey',
      'clientSecret',
      'privateKey',
      'refreshToken',
    ]) {
      expect(safeRepr({[name]: SENTINEL_TOKEN, marker: 1}, CAPS)).toBe(
        `{${name}: <String>, marker: 1}`,
      );
    }
    // The fold does not widen the rule: these are still ordinary names.
    expect(safeRepr({tokenizer: 'ok', marker: 1}, CAPS)).toBe(
      "{tokenizer: 'ok', marker: 1}",
    );
    expect(safeRepr({tokenCount: 3, marker: 1}, CAPS)).toBe(
      '{tokenCount: 3, marker: 1}',
    );
  });

  it('masks every ADK credential shape wherever it sits', () => {
    const shapes: ReadonlyArray<Record<string, unknown>> = [
      {type: 'service_account', private_key: SENTINEL_TOKEN},
      {serviceAccountCredential: {privateKey: SENTINEL_TOKEN}},
      {scopes: ['a'], useDefaultCredential: true},
      {scopes: ['a'], useIdToken: true},
      {scheme: 'bearer', credentials: {token: SENTINEL_TOKEN}},
      {username: 'u', password: SENTINEL_TOKEN},
      {clientId: 'c', clientSecret: SENTINEL_TOKEN},
    ];

    for (const shape of shapes) {
      expect(safeRepr({held: shape}, CAPS)).toBe('{held: <Object>}');
    }
  });

  it('leaves a value that only resembles a credential readable', () => {
    // Every key must belong to the shape, so a tool result keeps its rows and
    // loses only the token, which the name rule masks.
    expect(safeRepr({accessToken: SENTINEL_TOKEN, rows: [1]}, CAPS)).toBe(
      '{accessToken: <String>, rows: [1]}',
    );
  });

  it('wraps a prototype that names no constructor', async () => {
    const bareProto: {helper(): number} = Object.create(null);
    bareProto.helper = function helper(): number {
      return 1;
    };
    const holder: {helper(): number} = Object.create(bareProto);

    await instrument({graph: {holder}});

    expect(holder.helper()).toBe(1);
    // No constructor to name the owner with, so the span is the bare name.
    expect(spanNames()).toContain('helper');
  });

  it('carries on when rebinding a property throws', async () => {
    const hostile = new Proxy(
      {
        blocked(): number {
          return 1;
        },
      },
      {
        defineProperty(): never {
          throw new Error('rebinding refused');
        },
      },
    );
    const sibling = {
      survivor(): number {
        return 2;
      },
    };

    await instrument({graph: {hostile, sibling}});

    expect(isWrapped(hostile.blocked)).toBe(false);
    expect(sibling.survivor()).toBe(2);
    expect(spanNames()).toContain('survivor');
  });

  it('keeps the yields of a wrapped generator identical to the original', async () => {
    const graph = {
      *steps(): Generator<string> {
        yield 'a';
        yield 'b';
      },
      async *asyncSteps(): AsyncGenerator<string> {
        yield 'c';
        yield 'd';
      },
    };
    await instrument({graph});

    expect([...graph.steps()]).toEqual(['a', 'b']);
    const collected: string[] = [];
    for await (const item of graph.asyncSteps()) {
      collected.push(item);
    }
    expect(collected).toEqual(['c', 'd']);
  });
});
