/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {toSerializable} from '../../src/utils/serialization_utils.js';
import {isBaseNode, START, toContent} from '../../src/workflow/base_node.js';
import {
  isNodeSchemaValidationError,
  NodeSchemaValidationError,
} from '../../src/workflow/errors.js';
import {node} from '../../src/workflow/node.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {findStaticNodePath} from '../../src/workflow/utils/node_path_utils.js';
import {isWorkflow, Workflow} from '../../src/workflow/workflow.js';
import {driveNode, FnNode} from './test_helpers.js';

describe('isBaseNode', () => {
  it('recognizes node instances and the START sentinel', () => {
    expect(isBaseNode(new FnNode('n', (_c, i) => i))).toBe(true);
    expect(isBaseNode(START)).toBe(true);
  });

  it('rejects non-nodes', () => {
    expect(isBaseNode({})).toBe(false);
    expect(isBaseNode(null)).toBe(false);
    expect(isBaseNode('START')).toBe(false);
  });
});

describe('isWorkflow', () => {
  const workflow = new Workflow({
    name: 'wf',
    edges: [['START', node(() => 'x', {name: 'step'})]],
  });

  it('recognizes a Workflow', () => {
    expect(isWorkflow(workflow)).toBe(true);
    // The brand is an instance field, so it survives the `@experimental`
    // decorator wrapping the class.
    expect(isBaseNode(workflow)).toBe(true);
  });

  it('rejects other nodes and non-nodes', () => {
    expect(isWorkflow(new FnNode('n', (_c, i) => i))).toBe(false);
    expect(isWorkflow(START)).toBe(false);
    expect(isWorkflow({})).toBe(false);
    expect(isWorkflow(null)).toBe(false);
  });
});

describe('toContent', () => {
  const text = (c: Content | undefined) => c?.parts?.[0]?.text;

  it('returns undefined for null / undefined', () => {
    expect(toContent(null)).toBeUndefined();
    expect(toContent(undefined)).toBeUndefined();
  });

  it('passes a Content value through unchanged', () => {
    const content: Content = {role: 'model', parts: [{text: 'hi'}]};
    expect(toContent(content)).toBe(content);
  });

  it('wraps a string into a text part', () => {
    expect(text(toContent('hello'))).toBe('hello');
  });

  it('wraps a Part and an array of Parts', () => {
    expect(text(toContent({text: 'p'}))).toBe('p');
    const many = toContent([{text: 'a'}, {text: 'b'}]);
    expect(many?.parts).toHaveLength(2);
  });

  it('serializes a plain object to JSON text', () => {
    expect(text(toContent({count: 1}))).toBe('{"count":1}');
  });

  it('serializes numbers and booleans to text', () => {
    expect(text(toContent(42))).toBe('42');
    expect(text(toContent(true))).toBe('true');
  });

  it('does not throw on a value JSON cannot serialize (circular ref)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => toContent(circular)).not.toThrow();
    expect(typeof text(toContent(circular))).toBe('string');
  });
});

/** A node holding one arbitrary field, for exercising the tree walk. */
class HolderNode extends FnNode {
  constructor(
    name: string,
    readonly slot: unknown = undefined,
  ) {
    super(name, (_ctx, input) => input);
  }
}

describe('BaseNode name validation', () => {
  it.each(['foo', '_foo', 'foo_bar', 'foo-bar', '__START__'])(
    'accepts the identifier %s',
    (name) => {
      expect(new FnNode(name, (_c, i) => i).name).toBe(name);
    },
  );

  it.each(['my node', '1abc', 'a.b', 'a!'])(
    'rejects the non-identifier %s',
    (name) => {
      expect(() => new FnNode(name, (_c, i) => i)).toThrow(
        /must be a valid identifier/,
      );
    },
  );

  it('names the offending value in the rejection message', () => {
    expect(() => new FnNode('my node', (_c, i) => i)).toThrow(
      'Found invalid node name: "my node"',
    );
  });

  it('trims a name before validating it', () => {
    expect(new FnNode('  spaced  ', (_c, i) => i).name).toBe('spaced');
  });

  it.each(['', '   '])(
    'still rejects the blank name %j as non-empty',
    (name) => {
      expect(() => new FnNode(name, (_c, i) => i)).toThrow(
        'Node name must be a non-empty string.',
      );
    },
  );

  it('still constructs the START sentinel', () => {
    expect(START.name).toBe('__START__');
    expect(isBaseNode(START)).toBe(true);
  });
});

describe('findStaticNodePath containers', () => {
  it('finds a node held in a Map field', () => {
    const child = new HolderNode('child');
    const root = new HolderNode('root', new Map([['a', child]]));
    expect(findStaticNodePath(root, child)).toBe('root.child');
  });

  it('finds a node held in a Set field', () => {
    const child = new HolderNode('child');
    const root = new HolderNode('root', new Set([child]));
    expect(findStaticNodePath(root, child)).toBe('root.child');
  });

  it('finds a node held in a plain-object field', () => {
    const child = new HolderNode('child');
    const root = new HolderNode('root', {a: child});
    expect(findStaticNodePath(root, child)).toBe('root.child');
  });

  it('ignores a non-container field', () => {
    const child = new HolderNode('child');
    const root = new HolderNode('root', 'just a string');
    expect(findStaticNodePath(root, child)).toBeUndefined();
  });

  it('does not descend into a container nested in a container', () => {
    const child = new HolderNode('child');
    const root = new HolderNode('root', [[child]]);
    expect(findStaticNodePath(root, child)).toBeUndefined();
  });

  it('does not reach a node held only by Workflow.graph', () => {
    // The reference has the same limit: its graph is a separate model, which
    // its walk also skips. Reported as a divergence, not fixed here.
    const step = node(() => 'x', {name: 'step'});
    const workflow = new Workflow({name: 'wf', edges: [['START', step]]});
    expect(findStaticNodePath(workflow, step)).toBeUndefined();
    expect(findStaticNodePath(workflow, workflow)).toBe('wf');
  });
});

describe('toSerializable', () => {
  it('passes primitives, null and undefined through', () => {
    expect(toSerializable(null)).toBeNull();
    expect(toSerializable(undefined)).toBeUndefined();
    expect(toSerializable(7)).toBe(7);
    expect(toSerializable('s')).toBe('s');
    expect(toSerializable(false)).toBe(false);
  });

  it('leaves an already-plain object equal to itself', () => {
    const plain = {a: 1, b: {c: [1, 2]}};
    expect(toSerializable(plain)).toEqual(plain);
  });

  it('leaves an already-plain array equal to itself', () => {
    const items = [1, {a: 2}];
    expect(toSerializable(items)).toEqual(items);
  });

  it('converts a Set to an array', () => {
    expect(toSerializable(new Set(['a', 'b']))).toEqual(['a', 'b']);
  });

  it('converts a Map to a plain object with stringified keys', () => {
    const map = new Map<unknown, unknown>([
      ['a', 1],
      [2, 'two'],
    ]);
    expect(toSerializable(map)).toEqual({a: 1, '2': 'two'});
  });

  it('converts a value nested in an array or an object', () => {
    const converted = toSerializable({tags: new Set(['a'])}) as {
      tags: string[];
    };
    expect(converted.tags).toEqual(['a']);
    expect(toSerializable([new Set([1])])).toEqual([[1]]);
  });

  it('dumps an object exposing toJSON, and converts the dump', () => {
    const dumpable = {
      hidden: 'no',
      toJSON: () => ({shown: new Set([1])}),
    };
    expect(toSerializable(dumpable)).toEqual({shown: [1]});
  });

  it('dumps a Date to its ISO string', () => {
    const date = new Date('2026-01-02T03:04:05.000Z');
    expect(toSerializable(date)).toBe('2026-01-02T03:04:05.000Z');
  });

  it('returns a value whose toJSON throws as it is', () => {
    const broken = {
      toJSON: () => {
        throw new Error('cannot dump');
      },
    };
    expect(toSerializable(broken)).toBe(broken);
  });

  it('flattens a class instance without toJSON to its own properties', () => {
    class Point {
      constructor(
        readonly x: number,
        readonly y: number,
      ) {}
      get sum(): number {
        return this.x + this.y;
      }
    }
    const converted = toSerializable(new Point(1, 2));
    expect(converted).toEqual({x: 1, y: 2});
    expect(Object.getPrototypeOf(converted)).toBe(Object.prototype);
  });

  it('returns a circular structure without overflowing the stack', () => {
    const circular: Record<string, unknown> = {tags: new Set(['a'])};
    circular.self = circular;
    const converted = toSerializable(circular) as Record<string, unknown>;
    expect(converted.tags).toEqual(['a']);
    expect(converted.self).toBe(circular);
  });

  it('converts an object reached twice on separate paths', () => {
    const shared = {tags: new Set(['a'])};
    const converted = toSerializable({first: shared, second: shared}) as Record<
      string,
      {tags: string[]}
    >;
    expect(converted.first.tags).toEqual(['a']);
    expect(converted.second.tags).toEqual(['a']);
  });
});

describe('node output serialization', () => {
  it('emits the output unchanged when the node declares no outputSchema', async () => {
    const output = {tags: new Set(['a'])};
    const emitted = await driveNode(new FnNode('plain', () => output));
    expect(emitted.output).toBe(output);
  });

  it('flattens a Set produced by an outputSchema', async () => {
    const schema = z.object({tags: z.set(z.string())});
    const emitted = await driveNode(
      new FnNode('tagger', () => ({tags: new Set(['a', 'b'])}), {
        outputSchema: schema,
      }),
    );
    expect(emitted.output).toEqual({tags: ['a', 'b']});
  });

  it('still throws NodeSchemaValidationError on an output-schema failure', async () => {
    const bad = new FnNode('counter', () => ({count: 'oops'}), {
      outputSchema: z.object({count: z.number()}),
    });
    try {
      await driveNode(bad);
      expect.unreachable('expected a NodeSchemaValidationError');
    } catch (e) {
      expect(isNodeSchemaValidationError(e)).toBe(true);
      expect((e as NodeSchemaValidationError).direction).toBe('output');
    }
  });

  it('passes a genai Content output through even with an outputSchema', async () => {
    const output: Content = {role: 'model', parts: [{text: 'hi'}]};
    const emitted = await driveNode(
      new FnNode('speaker', () => output, {
        outputSchema: z.object({unrelated: z.string()}),
      }),
    );
    expect(emitted.output).toBe(output);
  });
});

describe('BaseNode name validation, additional cases', () => {
  const build = (name: string) => () => new FnNode(name, (_c, i) => i);

  it('accepts identifier-shaped names', () => {
    for (const name of [
      'snake_case',
      'camelCase',
      '_leading_underscore',
      'with-hyphen',
      'n1',
      START.name,
    ]) {
      expect(build(name)().name).toBe(name);
    }
  });

  it('constructs the START sentinel', () => {
    expect(START.name).toBe('__START__');
  });

  it('rejects a name that is not an identifier, naming the value', () => {
    for (const name of ['my node', '1abc', 'a.b', 'a/b']) {
      expect(build(name)).toThrow(
        `Found invalid node name: "${name}". Node name must be a valid identifier.`,
      );
    }
  });

  it('keeps the non-empty message for an empty or blank name', () => {
    expect(build('')).toThrow('Node name must be a non-empty string.');
    expect(build('   ')).toThrow('Node name must be a non-empty string.');
  });
});

describe('node output flattening', () => {
  it('leaves the output of a node without an outputSchema untouched', async () => {
    const output = {tags: new Set(['a'])};
    const {events} = await driveNode(new FunctionNode('plain', () => output));
    expect(events.at(-1)?.output).toBe(output);
  });

  it('flattens a Date the outputSchema produced', async () => {
    const node = new FunctionNode(
      'dated',
      () => ({when: '2026-01-02T03:04:05.000Z'}),
      {outputSchema: z.object({when: z.coerce.date()})},
    );
    const {events} = await driveNode(node);
    expect(events.at(-1)?.output).toEqual({
      when: '2026-01-02T03:04:05.000Z',
    });
  });

  it('flattens a class instance a transform produced', async () => {
    class Tags {
      constructor(readonly values: string[]) {}
    }
    const node = new FunctionNode('tagged', () => ['a', 'b'], {
      outputSchema: z.array(z.string()).transform((v) => new Tags(v)),
    });
    const {events} = await driveNode(node);
    expect(events.at(-1)?.output).toEqual({values: ['a', 'b']});
  });

  it('names the node when flattening a hostile output fails', async () => {
    const hostile = {
      get boom(): unknown {
        throw new Error('nope');
      },
    };
    const node = new FunctionNode('hostile', () => hostile, {
      outputSchema: z.any(),
    });
    try {
      await driveNode(node);
      expect.unreachable('expected a NodeSchemaValidationError');
    } catch (e) {
      expect(isNodeSchemaValidationError(e)).toBe(true);
      const err = e as NodeSchemaValidationError;
      expect(err.nodeName).toBe('hostile');
      expect(err.direction).toBe('output');
    }
  });
});
