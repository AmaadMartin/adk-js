/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  PluginManager,
  UiWidget,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function makeInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'i-1',
    session: createSession({id: 'test-session', appName: 'test-app'}),
    pluginManager: new PluginManager(),
  });
}

function makeWidget(id: string): UiWidget {
  return {id, provider: 'mcp', payload: {resource_uri: 'ui://demo/card'}};
}

describe('Context.renderUiWidget', () => {
  it('initialises the list and appends the widget', () => {
    const context = new Context({
      invocationContext: makeInvocationContext(),
    });
    expect(context.actions.renderUiWidgets).toBeUndefined();

    context.renderUiWidget(makeWidget('call-1'));

    expect(context.actions.renderUiWidgets).toEqual([makeWidget('call-1')]);
  });

  it('appends a second widget with a different id', () => {
    const context = new Context({
      invocationContext: makeInvocationContext(),
    });

    context.renderUiWidget(makeWidget('call-1'));
    context.renderUiWidget(makeWidget('call-2'));

    expect(context.actions.renderUiWidgets?.map((widget) => widget.id)).toEqual(
      ['call-1', 'call-2'],
    );
  });

  it('throws on a duplicate widget id', () => {
    const context = new Context({
      invocationContext: makeInvocationContext(),
    });
    context.renderUiWidget(makeWidget('call-1'));

    expect(() => context.renderUiWidget(makeWidget('call-1'))).toThrow(
      "UI widget with ID 'call-1' already exists",
    );
    expect(context.actions.renderUiWidgets).toHaveLength(1);
  });
});

describe('Context.customMetadata', () => {
  it('is the invocation-scoped store', () => {
    const invocationContext = makeInvocationContext();
    const context = new Context({invocationContext});

    context.customMetadata['http_debug_info'] = ['exchange'];

    expect(invocationContext.customMetadata).toEqual({
      http_debug_info: ['exchange'],
    });
  });

  it('starts empty', () => {
    const context = new Context({
      invocationContext: makeInvocationContext(),
    });

    expect(context.customMetadata).toEqual({});
  });

  it('is shared with a context built from a clone of the invocation', () => {
    const invocationContext = makeInvocationContext();
    const context = new Context({invocationContext});
    context.customMetadata['seen'] = true;

    const cloned = new Context({
      invocationContext: invocationContext.clone({branch: 'child'}),
    });

    expect(cloned.customMetadata).toEqual({seen: true});
    cloned.customMetadata['also'] = 1;
    expect(context.customMetadata).toEqual({seen: true, also: 1});
  });
});
