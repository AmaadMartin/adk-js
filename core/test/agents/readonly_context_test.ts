/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  isReadonlyStateError,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {ReadonlyState} from '../../src/sessions/readonly_state.js';

/** Returns the value `fn` throws, or undefined when it does not throw. */
function thrownBy(fn: () => void): unknown {
  try {
    fn();
  } catch (e: unknown) {
    return e;
  }
  return undefined;
}

function makeInvocationContext(
  state: Record<string, unknown>,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-1',
    session: createSession({id: 'sess-1', appName: 'app', userId: 'u', state}),
    pluginManager: new PluginManager(),
  });
}

describe('ReadonlyContext.state', () => {
  describe('reads', () => {
    it('reads through to the session state', () => {
      const ctx = new ReadonlyContext(makeInvocationContext({a: 1}));

      expect(ctx.state.get<number>('a')).toBe(1);
      expect(ctx.state.get<number>('missing', 7)).toBe(7);
      expect(ctx.state.has('a')).toBe(true);
      expect(ctx.state.has('missing')).toBe(false);
      expect(ctx.state.toRecord()).toEqual({a: 1});
    });

    it('sees a value written to the session after the view was taken', () => {
      const invocationContext = makeInvocationContext({a: 1});
      const ctx = new ReadonlyContext(invocationContext);
      const view = ctx.state;

      invocationContext.session.state['a'] = 2;

      expect(view.get<number>('a')).toBe(2);
      expect(ctx.state.get<number>('a')).toBe(2);
    });
  });

  describe('writes', () => {
    it('rejects set and leaves the session state unchanged', () => {
      const invocationContext = makeInvocationContext({a: 1});
      const ctx = new ReadonlyContext(invocationContext);

      const err = thrownBy(() => (ctx.state as ReadonlyState).set('b', 2));

      if (!isReadonlyStateError(err)) {
        expect.fail(`expected a ReadonlyStateError, got ${String(err)}`);
      }
      expect(err.message).toContain("Cannot set 'b'");
      expect(invocationContext.session.state).toEqual({a: 1});
      expect(ctx.state.toRecord()).toEqual({a: 1});
    });

    it('rejects update and leaves the session state unchanged', () => {
      const invocationContext = makeInvocationContext({a: 1});
      const ctx = new ReadonlyContext(invocationContext);

      const err = thrownBy(() =>
        (ctx.state as ReadonlyState).update({b: 2, c: 3}),
      );

      if (!isReadonlyStateError(err)) {
        expect.fail(`expected a ReadonlyStateError, got ${String(err)}`);
      }
      expect(err.message).toContain("Cannot update 'b', 'c'");
      expect(invocationContext.session.state).toEqual({a: 1});
      expect(ctx.state.toRecord()).toEqual({a: 1});
    });
  });

  describe('Context over the same invocation context', () => {
    it('still writes to the session and records the delta', () => {
      const invocationContext = makeInvocationContext({a: 1});
      const context = new Context({invocationContext});

      context.state.set('b', 2);

      expect(invocationContext.session.state['b']).toBe(2);
      expect(context.eventActions.stateDelta['b']).toBe(2);
    });
  });

  describe('instruction provider seam', () => {
    it('propagates the error and does not corrupt the session', async () => {
      const invocationContext = makeInvocationContext({a: 1});
      const agent = new LlmAgent({
        name: 'writer',
        instruction: (context: ReadonlyContext) => {
          (context.state as ReadonlyState).set('a', 2);
          return 'unreachable';
        },
      });

      await expect(
        agent.canonicalInstruction(new ReadonlyContext(invocationContext)),
      ).rejects.toThrow("Cannot set 'a'");
      expect(invocationContext.session.state).toEqual({a: 1});
    });
  });
});
