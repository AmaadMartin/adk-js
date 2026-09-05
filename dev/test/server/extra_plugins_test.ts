/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event, InMemorySessionService} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';
import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {loadExtraPlugins} from '../../src/server/extra_plugins.js';
import {CapturingLogger} from '../capturing_logger.js';
import {createStubAgentLoader, postJson} from './api_server_test_helpers.js';

const FIXTURE_MODULE = './dev/test/server/testdata/example_plugins';
const CLASS_PLUGIN = `${FIXTURE_MODULE}.MarkingPlugin`;
const INSTANCE_PLUGIN = `${FIXTURE_MODULE}.readyMadePlugin`;

describe('loadExtraPlugins', () => {
  let logger: CapturingLogger;

  beforeEach(() => {
    logger = new CapturingLogger();
  });

  it('constructs a class export with its qualified name', async () => {
    const plugins = await loadExtraPlugins([CLASS_PLUGIN], logger);

    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe(CLASS_PLUGIN);
    expect(logger.errorMessages).toEqual([]);
  });

  it('uses an instance export as it is', async () => {
    const plugins = await loadExtraPlugins([INSTANCE_PLUGIN], logger);

    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('ready_made');
  });

  it('skips a module that cannot be imported, and keeps the rest', async () => {
    const plugins = await loadExtraPlugins(
      ['./dev/test/server/testdata/no_such_module.Missing', CLASS_PLUGIN],
      logger,
    );

    expect(plugins).toHaveLength(1);
    expect(logger.errorMessages.join('\n')).toContain(
      'Failed to load plugin ./dev/test/server/testdata/no_such_module.Missing',
    );
  });

  it('skips an export the module does not have, and keeps the rest', async () => {
    const plugins = await loadExtraPlugins(
      [`${FIXTURE_MODULE}.NoSuchExport`, CLASS_PLUGIN],
      logger,
    );

    expect(plugins).toHaveLength(1);
    expect(logger.errorMessages.join('\n')).toContain(
      'NoSuchExport is not exported by the module',
    );
  });

  it('skips an export that is not a plugin, and keeps the rest', async () => {
    const plugins = await loadExtraPlugins(
      [`${FIXTURE_MODULE}.notAPlugin`, CLASS_PLUGIN],
      logger,
    );

    expect(plugins).toHaveLength(1);
    expect(logger.errorMessages.join('\n')).toContain(
      'notAPlugin is not a plugin',
    );
  });

  it('skips a name that does not separate a module from an export', async () => {
    const plugins = await loadExtraPlugins(['RecordingPlugin'], logger);

    expect(plugins).toEqual([]);
    expect(logger.errorMessages.join('\n')).toContain(
      'expected a "<module>.<export>" name',
    );
  });

  it('loads nothing when no plugin is named', async () => {
    expect(await loadExtraPlugins([], logger)).toEqual([]);
  });
});

describe('extra plugins on a running server', () => {
  async function runAgainstServer(extraPlugins: string[]): Promise<Event[]> {
    const sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: 'pluginApp',
      userId: 'u1',
      sessionId: 's1',
    });

    const server = new AdkApiServer({
      agentLoader: createStubAgentLoader('pluginApp'),
      sessionService,
      extraPlugins,
    });
    await server.start();

    try {
      const response = await postJson<Event[]>(`${server.url}/run`, {
        appName: 'pluginApp',
        userId: 'u1',
        sessionId: 's1',
        newMessage: {role: 'user', parts: [{text: 'Hi'}]},
      });
      expect(response.status).toBe(200);
      return response.body;
    } finally {
      await server.stop();
    }
  }

  it('runs a class-named plugin, constructed with its qualified name', async () => {
    const events = await runAgainstServer([CLASS_PLUGIN]);

    expect(events[0].content?.parts?.[0].text).toBe(
      `marked by ${CLASS_PLUGIN}`,
    );
  });

  it('runs an instance-named plugin', async () => {
    const events = await runAgainstServer([INSTANCE_PLUGIN]);

    expect(events[0].content?.parts?.[0].text).toBe('marked by ready_made');
  });

  it('leaves the run untouched when no plugin is configured', async () => {
    const events = await runAgainstServer([]);

    expect(events[0].content?.parts?.[0].text).toBe('Hello');
  });
});
