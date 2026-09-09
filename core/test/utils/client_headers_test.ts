/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {runWithClientLabel} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  getTrackingHeaders,
  mergeTrackingHeaders,
} from '../../src/utils/client_headers.js';

const API_CLIENT_HEADER = 'x-goog-api-client';
const USER_AGENT_HEADER = 'user-agent';

describe('getTrackingHeaders', () => {
  it('returns the same client label value under both tracking keys', () => {
    const headers = getTrackingHeaders();

    expect(headers[API_CLIENT_HEADER]).toContain('google-adk/');
    expect(headers[USER_AGENT_HEADER]).toEqual(headers[API_CLIENT_HEADER]);
  });
});

describe('mergeTrackingHeaders', () => {
  it('returns exactly the tracking headers when given no headers', () => {
    expect(mergeTrackingHeaders()).toEqual(getTrackingHeaders());
  });

  it('returns exactly the tracking headers when given an empty map', () => {
    expect(mergeTrackingHeaders({})).toEqual(getTrackingHeaders());
  });

  it('copies a non-tracking header through and adds the tracking keys', () => {
    const tracking = getTrackingHeaders();

    const merged = mergeTrackingHeaders({'x-custom-header': 'custom-value'});

    expect(merged).toEqual({
      'x-custom-header': 'custom-value',
      ...tracking,
    });
  });

  it('appends a caller token after the tracking tokens', () => {
    const tracking = getTrackingHeaders();

    const merged = mergeTrackingHeaders({
      [API_CLIENT_HEADER]: 'my-app/1.0',
      [USER_AGENT_HEADER]: 'my-app/1.0',
    });

    expect(merged[API_CLIENT_HEADER]).toEqual(
      `${tracking[API_CLIENT_HEADER]} my-app/1.0`,
    );
    expect(merged[USER_AGENT_HEADER]).toEqual(
      `${tracking[USER_AGENT_HEADER]} my-app/1.0`,
    );
  });

  it('drops a caller token that the tracking value already carries', () => {
    // adk-python: test asserting `tracking + " custom"` for `"custom " + tracking`.
    const tracking = getTrackingHeaders();

    const merged = mergeTrackingHeaders({
      [API_CLIENT_HEADER]: `custom ${tracking[API_CLIENT_HEADER]}`,
      [USER_AGENT_HEADER]: `custom ${tracking[USER_AGENT_HEADER]}`,
    });

    expect(merged[API_CLIENT_HEADER]).toEqual(
      `${tracking[API_CLIENT_HEADER]} custom`,
    );
    expect(merged[USER_AGENT_HEADER]).toEqual(
      `${tracking[USER_AGENT_HEADER]} custom`,
    );
  });

  it('does not double a caller value equal to the tracking value', () => {
    const tracking = getTrackingHeaders();

    expect(mergeTrackingHeaders({...tracking})).toEqual(tracking);
  });

  it('replaces an empty caller value with the tracking value', () => {
    const tracking = getTrackingHeaders();

    const merged = mergeTrackingHeaders({
      [API_CLIENT_HEADER]: '',
      [USER_AGENT_HEADER]: '',
    });

    expect(merged).toEqual(tracking);
  });

  it('does not mutate the headers it is given', () => {
    const headers = {[USER_AGENT_HEADER]: 'my-app/1.0'};

    mergeTrackingHeaders(headers);

    expect(headers).toEqual({[USER_AGENT_HEADER]: 'my-app/1.0'});
  });

  it('picks up a client label installed for the current async context', () => {
    const merged = runWithClientLabel('my-label', () =>
      mergeTrackingHeaders({[USER_AGENT_HEADER]: 'my-app/1.0'}),
    );

    expect(merged[USER_AGENT_HEADER]).toContain('my-label');
    expect(merged[USER_AGENT_HEADER]).toContain('my-app/1.0');
  });
});
