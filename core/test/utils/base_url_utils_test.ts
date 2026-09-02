/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {normalizeBaseUrlAndApiVersion} from '../../src/utils/base_url_utils.js';

describe('normalizeBaseUrlAndApiVersion', () => {
  it('returns nothing for an undefined base URL', () => {
    expect(normalizeBaseUrlAndApiVersion()).toEqual({});
  });

  it('returns nothing for an empty base URL', () => {
    expect(normalizeBaseUrlAndApiVersion('')).toEqual({});
  });

  it('lifts the version out of a Google base URL', () => {
    expect(
      normalizeBaseUrlAndApiVersion(
        'https://generativelanguage.googleapis.com/v1alpha',
      ),
    ).toEqual({
      baseUrl: 'https://generativelanguage.googleapis.com/',
      apiVersion: 'v1alpha',
    });
  });

  it('lifts the version out of a Google base URL with a trailing slash', () => {
    expect(
      normalizeBaseUrlAndApiVersion(
        'https://generativelanguage.googleapis.com/v1alpha/',
      ),
    ).toEqual({
      baseUrl: 'https://generativelanguage.googleapis.com/',
      apiVersion: 'v1alpha',
    });
  });

  it('keeps a non-default port in the normalized URL', () => {
    expect(
      normalizeBaseUrlAndApiVersion('https://x.googleapis.com:8443/v1beta1'),
    ).toEqual({
      baseUrl: 'https://x.googleapis.com:8443/',
      apiVersion: 'v1beta1',
    });
  });

  it('keeps the user info in the normalized URL', () => {
    expect(
      normalizeBaseUrlAndApiVersion('https://user:pw@x.googleapis.com/v1'),
    ).toEqual({
      baseUrl: 'https://user:pw@x.googleapis.com/',
      apiVersion: 'v1',
    });
  });

  it('keeps a user name without a password', () => {
    expect(
      normalizeBaseUrlAndApiVersion('https://user@x.googleapis.com/v1'),
    ).toEqual({
      baseUrl: 'https://user@x.googleapis.com/',
      apiVersion: 'v1',
    });
  });

  it('leaves a non-Google host untouched', () => {
    const baseUrl = 'https://proxy.example.com/gemini/v1alpha';
    expect(normalizeBaseUrlAndApiVersion(baseUrl)).toEqual({baseUrl});
  });

  it('leaves a URL with a query string untouched', () => {
    const baseUrl = 'https://x.googleapis.com/v1?a=b';
    expect(normalizeBaseUrlAndApiVersion(baseUrl)).toEqual({baseUrl});
  });

  it('leaves a URL with a fragment untouched', () => {
    const baseUrl = 'https://x.googleapis.com/v1#frag';
    expect(normalizeBaseUrlAndApiVersion(baseUrl)).toEqual({baseUrl});
  });

  it('leaves a URL with no path untouched', () => {
    const baseUrl = 'https://x.googleapis.com';
    expect(normalizeBaseUrlAndApiVersion(baseUrl)).toEqual({baseUrl});
  });

  it('leaves a URL whose path is just a slash untouched', () => {
    const baseUrl = 'https://x.googleapis.com/';
    expect(normalizeBaseUrlAndApiVersion(baseUrl)).toEqual({baseUrl});
  });

  it('leaves a path that only starts with a version untouched', () => {
    const baseUrl = 'https://x.googleapis.com/v1/models';
    expect(normalizeBaseUrlAndApiVersion(baseUrl)).toEqual({baseUrl});
  });

  it('leaves a path that is not a version untouched', () => {
    const baseUrl = 'https://x.googleapis.com/vertex';
    expect(normalizeBaseUrlAndApiVersion(baseUrl)).toEqual({baseUrl});
  });

  it('returns an unparseable base URL unchanged instead of throwing', () => {
    const baseUrl = 'not a url';
    expect(normalizeBaseUrlAndApiVersion(baseUrl)).toEqual({baseUrl});
  });
});
