/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  HttpDispatcher,
  resolveSslDispatcher,
  sslVerifyToAgentOptions,
} from '../../src/utils/ssl_utils.js';

const CA_PEM = '-----BEGIN CERTIFICATE-----\nnot-a-real-certificate\n';

/** A dispatcher the application built itself. */
const fakeDispatcher: HttpDispatcher = {dispatch: () => true};

describe('sslVerifyToAgentOptions', () => {
  let caDir: string;
  let caPath: string;

  beforeAll(async () => {
    caDir = await mkdtemp(join(tmpdir(), 'adk-ssl-utils-'));
    caPath = join(caDir, 'ca.pem');
    await writeFile(caPath, CA_PEM, 'utf8');
  });

  afterAll(async () => {
    await rm(caDir, {recursive: true, force: true});
  });

  it('asks for no agent when verification uses the system CA', async () => {
    await expect(sslVerifyToAgentOptions(true)).resolves.toBeUndefined();
  });

  it('turns off certificate verification for false', async () => {
    await expect(sslVerifyToAgentOptions(false)).resolves.toEqual({
      connect: {rejectUnauthorized: false},
    });
  });

  it('reads a CA bundle from a path', async () => {
    await expect(sslVerifyToAgentOptions(caPath)).resolves.toEqual({
      connect: {ca: CA_PEM},
    });
  });

  it('surfaces the read error for a missing CA bundle', async () => {
    await expect(
      sslVerifyToAgentOptions(join(caDir, 'absent.pem')),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe('resolveSslDispatcher', () => {
  let caDir: string;
  let caPath: string;

  beforeAll(async () => {
    caDir = await mkdtemp(join(tmpdir(), 'adk-ssl-dispatcher-'));
    caPath = join(caDir, 'ca.pem');
    await writeFile(caPath, CA_PEM, 'utf8');
  });

  afterAll(async () => {
    await rm(caDir, {recursive: true, force: true});
  });

  it('attaches no dispatcher when the setting is absent', async () => {
    await expect(resolveSslDispatcher(undefined)).resolves.toBeUndefined();
  });

  it('attaches no dispatcher when verification uses the system CA', async () => {
    await expect(resolveSslDispatcher(true)).resolves.toBeUndefined();
  });

  it('returns an application-supplied dispatcher unchanged', async () => {
    await expect(resolveSslDispatcher(fakeDispatcher)).resolves.toBe(
      fakeDispatcher,
    );
  });

  it('builds a dispatcher when verification is off', async () => {
    const dispatcher = await resolveSslDispatcher(false);

    expect(dispatcher?.dispatch).toBeTypeOf('function');
  });

  it('builds a dispatcher for a CA bundle path', async () => {
    const dispatcher = await resolveSslDispatcher(caPath);

    expect(dispatcher?.dispatch).toBeTypeOf('function');
  });
});
