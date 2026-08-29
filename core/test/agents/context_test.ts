/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  PluginManager,
  UiWidget,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function buildContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager(),
    }),
    functionCallId: 'call-1',
  });
}

function widget(id: string): UiWidget {
  return {id, provider: 'mcp', payload: {resource_uri: `ui://${id}`}};
}

describe('Context.renderUiWidget', () => {
  it('attaches the first widget to the event actions', () => {
    const context = buildContext();

    context.renderUiWidget(widget('call-1'));

    expect(context.eventActions.renderUiWidgets).toEqual([
      {id: 'call-1', provider: 'mcp', payload: {resource_uri: 'ui://call-1'}},
    ]);
  });

  it('keeps widgets in the order they were attached', () => {
    const context = buildContext();

    context.renderUiWidget(widget('first'));
    context.renderUiWidget(widget('second'));

    expect(context.eventActions.renderUiWidgets?.map((w) => w.id)).toEqual([
      'first',
      'second',
    ]);
  });

  it('refuses a second widget with the same id', () => {
    const context = buildContext();
    context.renderUiWidget(widget('call-1'));

    expect(() => {
      context.renderUiWidget(widget('call-1'));
    }).toThrow("UI widget 'call-1' is already attached.");
    expect(context.eventActions.renderUiWidgets).toHaveLength(1);
  });

  it('attaches nothing until a widget is rendered', () => {
    expect(buildContext().eventActions.renderUiWidgets).toBeUndefined();
  });
});
