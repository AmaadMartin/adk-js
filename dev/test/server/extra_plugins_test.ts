/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

import {
  loadExtraPlugins,
  parsePluginSpecifier,
} from '../../src/server/extra_plugins.js';
import {CapturingLogger} from '../capturing_logger.js';

const TESTDATA_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'testdata',
);
const PLUGIN_MODULE = './example_plugins.ts';

describe('parsePluginSpecifier', () => {
  it('reads the export named after the hash', () => {
    expect(parsePluginSpecifier('@acme/audit#AuditPlugin')).toEqual({
      moduleSpecifier: '@acme/audit',
      exportName: 'AuditPlugin',
    });
  });

  it('leaves the export unset when the specifier names none', () => {
    expect(parsePluginSpecifier('./plugin.js')).toEqual({
      moduleSpecifier: './plugin.js',
    });
  });

  it('splits on the last hash so a module may contain one', () => {
    expect(parsePluginSpecifier('./a#b/plugin.js#Audit')).toEqual({
      moduleSpecifier: './a#b/plugin.js',
      exportName: 'Audit',
    });
  });
});

describe('loadExtraPlugins', () => {
  it('instantiates a class export with the specifier as its name', async () => {
    const logger = new CapturingLogger();

    const plugins = await loadExtraPlugins(
      [`${PLUGIN_MODULE}#NamePlugin`],
      TESTDATA_DIR,
      logger,
    );

    expect(plugins.map((plugin) => plugin.name)).toEqual([
      `${PLUGIN_MODULE}#NamePlugin`,
    ]);
    expect(logger.errorMessages).toEqual([]);
  });

  it('uses an instance export as it is', async () => {
    const plugins = await loadExtraPlugins(
      [`${PLUGIN_MODULE}#namedInstance`],
      TESTDATA_DIR,
      new CapturingLogger(),
    );

    expect(plugins.map((plugin) => plugin.name)).toEqual(['preBuiltInstance']);
  });

  it('reads the default export when the specifier names none', async () => {
    const plugins = await loadExtraPlugins(
      [PLUGIN_MODULE],
      TESTDATA_DIR,
      new CapturingLogger(),
    );

    expect(plugins.map((plugin) => plugin.name)).toEqual(['defaultExport']);
  });

  it('resolves an absolute module specifier without an agents directory', async () => {
    const absolute = path.join(TESTDATA_DIR, 'example_plugins.ts');

    const plugins = await loadExtraPlugins(
      [`${absolute}#namedInstance`],
      undefined,
      new CapturingLogger(),
    );

    expect(plugins.map((plugin) => plugin.name)).toEqual(['preBuiltInstance']);
  });

  it('keeps the other plugins when one module cannot be imported', async () => {
    const logger = new CapturingLogger();

    const plugins = await loadExtraPlugins(
      ['./does_not_exist.ts#Missing', `${PLUGIN_MODULE}#namedInstance`],
      TESTDATA_DIR,
      logger,
    );

    expect(plugins.map((plugin) => plugin.name)).toEqual(['preBuiltInstance']);
    expect(logger.errorMessages).toHaveLength(1);
    expect(logger.errorMessages[0]).toContain(
      'Failed to load plugin ./does_not_exist.ts#Missing',
    );
  });

  it('reports a module that has no such export', async () => {
    const logger = new CapturingLogger();

    const plugins = await loadExtraPlugins(
      [`${PLUGIN_MODULE}#NoSuchExport`],
      TESTDATA_DIR,
      logger,
    );

    expect(plugins).toEqual([]);
    expect(logger.errorMessages[0]).toContain(
      'has no export named NoSuchExport',
    );
  });

  it('reports an export that is not a plugin', async () => {
    const logger = new CapturingLogger();

    const plugins = await loadExtraPlugins(
      [`${PLUGIN_MODULE}#notAPlugin`],
      TESTDATA_DIR,
      logger,
    );

    expect(plugins).toEqual([]);
    expect(logger.errorMessages[0]).toContain(
      'is neither a plugin instance nor a plugin class',
    );
  });

  it('loads nothing and reports nothing when no plugin is configured', async () => {
    const logger = new CapturingLogger();

    expect(await loadExtraPlugins([], TESTDATA_DIR, logger)).toEqual([]);
    expect(logger.errorMessages).toEqual([]);
  });
});
