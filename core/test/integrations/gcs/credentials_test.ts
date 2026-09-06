/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GCS_DEFAULT_SCOPES, GcsCredentialsConfig} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('GcsCredentialsConfig', () => {
  it('defaults the scopes for a client id and secret', () => {
    const config = new GcsCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
    });

    expect(config.clientId).toBe('abc');
    expect(config.clientSecret).toBe('def');
    expect(config.scopes).toEqual(GCS_DEFAULT_SCOPES);
    expect(config.storageOptions).toBeUndefined();
  });

  it('keeps explicitly configured scopes', () => {
    const config = new GcsCredentialsConfig({
      clientId: 'abc',
      clientSecret: 'def',
      scopes: ['https://www.googleapis.com/auth/devstorage.read_only'],
    });

    expect(config.scopes).toEqual([
      'https://www.googleapis.com/auth/devstorage.read_only',
    ]);
  });

  it('keeps ready-made storage options and leaves the OAuth fields unset', () => {
    const config = new GcsCredentialsConfig({
      storageOptions: {apiEndpoint: 'https://storage.example'},
    });

    expect(config.storageOptions).toEqual({
      apiEndpoint: 'https://storage.example',
    });
    expect(config.clientId).toBeUndefined();
    expect(config.clientSecret).toBeUndefined();
  });

  it('rejects an empty configuration', () => {
    expect(() => new GcsCredentialsConfig({})).toThrow(
      'Must provide either storageOptions, or both clientId and clientSecret.',
    );
  });

  it('rejects a client id without a client secret', () => {
    expect(() => new GcsCredentialsConfig({clientId: 'abc'})).toThrow(
      'Must provide either storageOptions, or both clientId and clientSecret.',
    );
  });

  it('rejects a client secret without a client id', () => {
    expect(() => new GcsCredentialsConfig({clientSecret: 'def'})).toThrow(
      'Must provide either storageOptions, or both clientId and clientSecret.',
    );
  });

  it('rejects storage options combined with OAuth client credentials', () => {
    expect(
      () =>
        new GcsCredentialsConfig({
          storageOptions: {},
          clientId: 'abc',
          clientSecret: 'def',
        }),
    ).toThrow(
      'If storageOptions are provided, clientId, clientSecret and scopes must not be provided.',
    );
  });

  it('rejects storage options combined with scopes', () => {
    expect(
      () =>
        new GcsCredentialsConfig({
          storageOptions: {},
          scopes: ['https://www.googleapis.com/auth/devstorage.read_only'],
        }),
    ).toThrow(
      'If storageOptions are provided, clientId, clientSecret and scopes must not be provided.',
    );
  });

  describe('toStorageOptions', () => {
    it('passes ready-made storage options through', () => {
      const config = new GcsCredentialsConfig({
        storageOptions: {apiEndpoint: 'https://storage.example'},
      });

      expect(config.toStorageOptions()).toEqual({
        apiEndpoint: 'https://storage.example',
      });
    });

    it('turns a client id and secret into client options and scopes', () => {
      const config = new GcsCredentialsConfig({
        clientId: 'abc',
        clientSecret: 'def',
      });

      expect(config.toStorageOptions()).toEqual({
        clientOptions: {clientId: 'abc', clientSecret: 'def'},
        scopes: GCS_DEFAULT_SCOPES,
      });
    });

    it('uses the configured project when no override is given', () => {
      const config = new GcsCredentialsConfig({
        storageOptions: {},
        projectId: 'configured-project',
      });

      expect(config.toStorageOptions()).toEqual({
        projectId: 'configured-project',
      });
    });

    it('lets the call site override the configured project', () => {
      const config = new GcsCredentialsConfig({
        storageOptions: {projectId: 'options-project'},
        projectId: 'configured-project',
      });

      expect(config.toStorageOptions('call-site-project')).toEqual({
        projectId: 'call-site-project',
      });
    });
  });
});
