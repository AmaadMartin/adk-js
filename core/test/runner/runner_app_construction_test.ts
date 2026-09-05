/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  BasePlugin,
  InMemorySessionService,
  LlmAgent,
  Runner,
  Workflow,
  node,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';

class MarkerPlugin extends BasePlugin {}

function newAgent(name = 'root_agent'): LlmAgent {
  return new LlmAgent({name, model: 'gemini-2.0-flash'});
}

function newWorkflow(name = 'wf'): Workflow {
  return new Workflow({
    name,
    edges: [['START', node(() => 'done', {name: 'step'})]],
  });
}

const sessionService = new InMemorySessionService();

describe('Runner construction', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects app and agent together, naming both', () => {
    const agent = newAgent();
    const app = new App({name: 'app', rootAgent: newAgent('other')});

    expect(() => new Runner({app, agent, sessionService})).toThrow(
      'Only one of app or agent may be provided, but got: app=App, ' +
        'agent=LlmAgent. Pass exactly one to Runner().',
    );
  });

  it('rejects a configuration with neither app nor agent', () => {
    expect(() => new Runner({sessionService})).toThrow(
      'One of app or agent must be provided. Got none. Pass exactly one to ' +
        'Runner().',
    );
  });

  it('rejects plugins alongside app', () => {
    const app = new App({name: 'app', rootAgent: newAgent()});

    expect(
      () => new Runner({app, plugins: [new MarkerPlugin('p')], sessionService}),
    ).toThrow(
      'When app is provided, plugins should not be provided and should be ' +
        'provided in the app instead.',
    );
  });

  it('warns about deprecated plugins but still registers them', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const plugin = new MarkerPlugin('marker');

    const runner = new Runner({
      appName: 'app',
      agent: newAgent(),
      plugins: [plugin],
      sessionService,
    });

    expect(warn).toHaveBeenCalledWith(
      "The 'plugins' option is deprecated. Please use the 'app' option to " +
        'provide plugins instead.',
    );
    expect(runner.app.plugins).toEqual([plugin]);
  });

  it('stays silent when no plugins are passed', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    new Runner({appName: 'app', agent: newAgent(), sessionService});

    expect(warn).not.toHaveBeenCalled();
  });

  it('lets appName override app.name', () => {
    const app = new App({name: 'app_from_app', rootAgent: newAgent()});

    const runner = new Runner({app, appName: 'override', sessionService});

    expect(runner.appName).toBe('override');
    expect(runner.app).toBe(app);
    expect(runner.app.name).toBe('app_from_app');
  });

  it('wraps a bare agent into an app carrying the root and the plugins', () => {
    const agent = newAgent();
    const plugin = new MarkerPlugin('marker');
    vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const runner = new Runner({
      appName: 'wrapped',
      agent,
      plugins: [plugin],
      sessionService,
    });

    expect(runner.app.name).toBe('wrapped');
    expect(runner.app.rootAgent).toBe(agent);
    expect(runner.app.plugins).toEqual([plugin]);
    expect(runner.agent).toBe(agent);
  });

  it('names a wrapped workflow after the node when no appName is given', () => {
    const workflow = newWorkflow('graph_app');

    const runner = new Runner({agent: workflow, sessionService});

    expect(runner.app.name).toBe('graph_app');
    expect(runner.appName).toBe('graph_app');
    expect(runner.app.rootAgent).toBe(workflow);
  });

  it('prefers an explicit appName over a wrapped workflow name', () => {
    const runner = new Runner({
      appName: 'explicit',
      agent: newWorkflow('graph_app'),
      sessionService,
    });

    expect(runner.appName).toBe('explicit');
    expect(runner.app.name).toBe('explicit');
  });

  it('leaves the app unnamed for a bare agent with no appName', () => {
    // adk-js reports a missing app name when the session lookup fails, so the
    // wrapper must not invent one from the agent.
    const runner = new Runner({agent: newAgent(), sessionService});

    expect(runner.appName).toBe('');
  });

  it('accepts a legacy app name the strict validator rejects', () => {
    const runner = new Runner({
      appName: '2legacy app',
      agent: newAgent(),
      sessionService,
    });

    expect(runner.appName).toBe('2legacy app');
    expect(runner.app.name).toBe('2legacy app');
    expect(() => new App({name: '2legacy app', rootAgent: newAgent()})).toThrow(
      /Invalid app name '2legacy app'/,
    );
  });

  it('carries the app resumability config onto the runner', () => {
    const app = new App({
      name: 'app',
      rootAgent: newAgent(),
      resumabilityConfig: {isResumable: true},
    });

    expect(new Runner({app, sessionService}).resumabilityConfig).toEqual({
      isResumable: true,
    });
  });
});
