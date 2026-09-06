/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getClientLabels, runWithClientLabel} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  getTrackingHeaders,
  getTrackingHttpOptions,
  mergeTrackingHeaders,
} from '../../src/utils/tracking_headers_utils.js';

describe('getTrackingHeaders', () => {
  it('sends the same joined labels in both headers', () => {
    const headers = getTrackingHeaders();
    const expected = getClientLabels().join(' ');

    expect(headers).toEqual({
      'x-goog-api-client': expected,
      'user-agent': expected,
    });
  });

  it('carries a custom client label', () => {
    const headers = runWithClientLabel('my-app/1.0', () =>
      getTrackingHeaders(),
    );

    expect(headers['x-goog-api-client']).toContain('my-app/1.0');
    expect(headers['user-agent']).toContain('my-app/1.0');
  });

  it('appends the framework label to the google-adk token', () => {
    const headers = getTrackingHeaders('managed_agent');

    expect(headers['x-goog-api-client']).toContain('+managed_agent');
    expect(headers['user-agent']).toContain('+managed_agent');
  });
});

describe('getTrackingHttpOptions', () => {
  it('wraps the tracking headers', () => {
    expect(getTrackingHttpOptions()).toEqual({headers: getTrackingHeaders()});
  });

  it('forwards the framework label', () => {
    expect(getTrackingHttpOptions('managed_agent')).toEqual({
      headers: getTrackingHeaders('managed_agent'),
    });
  });
});

describe('mergeTrackingHeaders', () => {
  it('returns the tracking headers when the caller supplies none', () => {
    expect(mergeTrackingHeaders(undefined)).toEqual(getTrackingHeaders());
  });

  it('applies the framework label', () => {
    expect(mergeTrackingHeaders(undefined, 'managed_agent')).toEqual(
      getTrackingHeaders('managed_agent'),
    );
  });

  it('keeps a caller header the tracking set does not use', () => {
    const merged = mergeTrackingHeaders({'x-custom': 'value'});

    expect(merged['x-custom']).toBe('value');
    expect(merged['x-goog-api-client']).toBe(
      getTrackingHeaders()['x-goog-api-client'],
    );
  });

  it('appends the caller tokens after the tracking tokens', () => {
    const merged = mergeTrackingHeaders(
      {'x-goog-api-client': 'caller/1.0'},
      'managed_agent',
    );
    const tracking = getTrackingHeaders('managed_agent')['x-goog-api-client'];

    expect(merged['x-goog-api-client']).toBe(`${tracking} caller/1.0`);
  });

  it('does not duplicate a token the tracking value already carries', () => {
    const tracking = getTrackingHeaders()['x-goog-api-client'];
    const [frameworkToken] = tracking.split(' ');

    const merged = mergeTrackingHeaders({
      'x-goog-api-client': `${frameworkToken} caller/1.0`,
    });

    expect(merged['x-goog-api-client']).toBe(`${tracking} caller/1.0`);
    expect(merged['x-goog-api-client'].split(' ')).toEqual([
      ...new Set(merged['x-goog-api-client'].split(' ')),
    ]);
  });

  it('treats an empty caller value as absent', () => {
    const merged = mergeTrackingHeaders({'user-agent': ''});

    expect(merged['user-agent']).toBe(getTrackingHeaders()['user-agent']);
  });

  it('does not mutate the caller headers', () => {
    const callerHeaders = {'x-goog-api-client': 'caller/1.0'};

    mergeTrackingHeaders(callerHeaders);

    expect(callerHeaders).toEqual({'x-goog-api-client': 'caller/1.0'});
  });
});
