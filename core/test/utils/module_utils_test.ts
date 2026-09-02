/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createUserContent} from '@google/genai';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

import {InputValidationError} from '../../src/errors/input_validation_error.js';
import {resolveFullyQualifiedName} from '../../src/utils/module_utils.js';
import {notAnAgent, weatherAgent} from '../tools/fixtures/config_agents.js';

/** Absolute path of the fixture module the resolver loads. */
const FIXTURE_PATH = fileURLToPath(
  new URL('../tools/fixtures/config_agents.ts', import.meta.url),
);

/**
 * Absolute path of a config file sitting next to the fixture. The resolver
 * uses it as a base for a relative specifier and never reads it.
 */
const CONFIG_PATH = fileURLToPath(
  new URL('../tools/fixtures/root_agent.yaml', import.meta.url),
);

describe('resolveFullyQualifiedName', () => {
  it('resolves a named export by identity', async () => {
    const resolved = await resolveFullyQualifiedName(
      `${FIXTURE_PATH}#weatherAgent`,
      CONFIG_PATH,
    );

    expect(resolved).toBe(weatherAgent);
  });

  it('resolves the default export when the name has no separator', async () => {
    const resolved = await resolveFullyQualifiedName(FIXTURE_PATH, CONFIG_PATH);

    expect(resolved).toBe(weatherAgent);
  });

  it('resolves the default export when nothing follows the separator', async () => {
    const resolved = await resolveFullyQualifiedName(
      `${FIXTURE_PATH}#`,
      CONFIG_PATH,
    );

    expect(resolved).toBe(weatherAgent);
  });

  it('rebases a relative specifier against the base file', async () => {
    const resolved = await resolveFullyQualifiedName(
      './config_agents.ts#notAnAgent',
      CONFIG_PATH,
    );

    expect(resolved).toBe(notAnAgent);
  });

  it('ignores the base file for an absolute specifier', async () => {
    const resolved = await resolveFullyQualifiedName(
      `${FIXTURE_PATH}#notAnAgent`,
      '/nowhere/root_agent.yaml',
    );

    expect(resolved).toBe(notAnAgent);
  });

  it('resolves a bare specifier through normal package resolution', async () => {
    const resolved = await resolveFullyQualifiedName(
      '@google/genai#createUserContent',
      CONFIG_PATH,
    );

    expect(resolved).toBe(createUserContent);
  });

  it('reports a module that cannot be loaded, keeping the cause', async () => {
    const name = '/no/such/module.ts#weatherAgent';
    const resolving = resolveFullyQualifiedName(name, CONFIG_PATH);

    await expect(resolving).rejects.toThrow(InputValidationError);
    await expect(resolving).rejects.toMatchObject({
      message: `Invalid fully qualified name: ${name}`,
      cause: expect.any(Error),
    });
  });

  it('reports a missing export instead of returning undefined', async () => {
    const name = `${FIXTURE_PATH}#noSuchExport`;
    const resolving = resolveFullyQualifiedName(name, CONFIG_PATH);

    await expect(resolving).rejects.toThrow(InputValidationError);
    await expect(resolving).rejects.toMatchObject({
      message: `Invalid fully qualified name: ${name}`,
      cause: {
        message: expect.stringContaining('has no export named "noSuchExport"'),
      },
    });
  });

  it('refuses a namespaced Node built-in', async () => {
    const resolving = resolveFullyQualifiedName(
      'node:child_process#execSync',
      CONFIG_PATH,
    );

    await expect(resolving).rejects.toThrow(InputValidationError);
    await expect(resolving).rejects.toMatchObject({
      cause: {message: expect.stringContaining('node:child_process')},
    });
  });

  it('refuses a bare Node built-in', async () => {
    const resolving = resolveFullyQualifiedName('fs#readFileSync', CONFIG_PATH);

    await expect(resolving).rejects.toThrow(InputValidationError);
    await expect(resolving).rejects.toMatchObject({
      cause: {message: expect.stringContaining('"fs"')},
    });
  });
});
