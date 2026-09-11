/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';

import {loadExtraPlugins} from '../../src/server/extra_plugins.js';
import {CapturingLogger} from './capturing_logger.js';

const FIXTURE_MODULE = path
  .join(__dirname, 'testdata', 'example_plugins.ts')
  .replace(/\\/g, '/');

describe('loadExtraPlugins', () => {
  let logger: CapturingLogger;

  beforeEach(() => {
    logger = new CapturingLogger();
  });

  it('loads nothing when no plugin is named', async () => {
    expect(await loadExtraPlugins([], logger)).toEqual([]);
    expect(logger.errors).toEqual([]);
  });

  it('uses a named plugin instance as it stands', async () => {
    const plugins = await loadExtraPlugins(
      [`${FIXTURE_MODULE}#examplePluginInstance`],
      logger,
    );

    expect(plugins.map((plugin) => plugin.name)).toEqual(['configured-name']);
    expect(logger.errors).toEqual([]);
  });

  it('constructs a named plugin class with the qualified name', async () => {
    const qualifiedName = `${FIXTURE_MODULE}#ExamplePlugin`;

    const plugins = await loadExtraPlugins([qualifiedName], logger);

    expect(plugins.map((plugin) => plugin.name)).toEqual([qualifiedName]);
  });

  it('loads every name it is given, in order', async () => {
    const plugins = await loadExtraPlugins(
      [
        `${FIXTURE_MODULE}#examplePluginInstance`,
        `${FIXTURE_MODULE}#ExamplePlugin`,
      ],
      logger,
    );

    expect(plugins).toHaveLength(2);
    expect(plugins[0].name).toBe('configured-name');
  });

  it('skips and reports a name that is not a plugin', async () => {
    const plugins = await loadExtraPlugins(
      [`${FIXTURE_MODULE}#notAPlugin`],
      logger,
    );

    expect(plugins).toEqual([]);
    expect(logger.errors.join('\n')).toContain(
      'neither a BasePlugin instance nor a BasePlugin subclass',
    );
  });

  it('skips and reports a module that does not resolve', async () => {
    const plugins = await loadExtraPlugins(
      ['@acme/no-such-package#AuditPlugin'],
      logger,
    );

    expect(plugins).toEqual([]);
    expect(logger.errors.join('\n')).toContain(
      'Failed to load plugin @acme/no-such-package#AuditPlugin',
    );
  });

  it('skips and reports an export the module does not have', async () => {
    const plugins = await loadExtraPlugins(
      [`${FIXTURE_MODULE}#MissingPlugin`],
      logger,
    );

    expect(plugins).toEqual([]);
    expect(logger.errors.join('\n')).toContain('MissingPlugin');
  });

  it('keeps loading the remaining names after one fails', async () => {
    const plugins = await loadExtraPlugins(
      [
        '@acme/no-such-package#AuditPlugin',
        `${FIXTURE_MODULE}#examplePluginInstance`,
      ],
      logger,
    );

    expect(plugins.map((plugin) => plugin.name)).toEqual(['configured-name']);
    expect(logger.errors).toHaveLength(1);
  });
});
