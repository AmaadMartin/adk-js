/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  CLOUD_PLATFORM_SCOPE,
  DEFAULT_PUBLISH_TIMEOUT_MS,
  EventarcToolConfig,
  resolvePublishTimeoutMs,
  resolveScopes,
} from '../../../src/integrations/eventarc/config.js';

describe('resolvePublishTimeoutMs', () => {
  it('falls back to the default when no config is supplied', () => {
    expect(resolvePublishTimeoutMs()).toBe(DEFAULT_PUBLISH_TIMEOUT_MS);
  });

  it('falls back to the default when the timeout is unset', () => {
    const config: EventarcToolConfig = {projectId: 'my-project'};
    expect(resolvePublishTimeoutMs(config)).toBe(DEFAULT_PUBLISH_TIMEOUT_MS);
    expect(config.projectId).toBe('my-project');
  });

  it('keeps an explicit timeout', () => {
    expect(resolvePublishTimeoutMs({publishTimeoutMs: 30_000})).toBe(30_000);
  });

  it('keeps a zero timeout instead of treating it as unset', () => {
    expect(resolvePublishTimeoutMs({publishTimeoutMs: 0})).toBe(0);
  });

  it('matches the 15 second default of the Python toolset', () => {
    expect(DEFAULT_PUBLISH_TIMEOUT_MS).toBe(15_000);
  });
});

describe('resolveScopes', () => {
  it('falls back to the cloud-platform scope when no config is supplied', () => {
    expect(resolveScopes()).toEqual([CLOUD_PLATFORM_SCOPE]);
  });

  it('falls back to the cloud-platform scope when scopes are unset', () => {
    expect(resolveScopes({})).toEqual([CLOUD_PLATFORM_SCOPE]);
  });

  it('keeps explicit scopes', () => {
    const scopes = ['https://www.googleapis.com/auth/eventarc'];
    expect(resolveScopes({scopes})).toEqual(scopes);
  });
});
