/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  buildRuntimeConfig,
  resolveLogoConfig,
  RUNTIME_CONFIG_RELATIVE_PATH,
} from '../../src/server/runtime_config.js';

const INCOMPLETE_LOGO_ERROR =
  'Both logoText and logoImageUrl must be defined when using logo config.';

describe('resolveLogoConfig', () => {
  it('returns the logo block when both values are supplied', () => {
    expect(resolveLogoConfig('T', 'U')).toEqual({text: 'T', imageUrl: 'U'});
  });

  it('returns undefined when neither value is supplied', () => {
    expect(resolveLogoConfig(undefined, undefined)).toBeUndefined();
  });

  it('throws when only the text is supplied', () => {
    expect(() => resolveLogoConfig('T', undefined)).toThrowError(
      INCOMPLETE_LOGO_ERROR,
    );
  });

  it('throws when only the image URL is supplied', () => {
    expect(() => resolveLogoConfig(undefined, 'U')).toThrowError(
      INCOMPLETE_LOGO_ERROR,
    );
  });

  it('treats an empty text as not supplied, matching adk-python', () => {
    expect(() => resolveLogoConfig('', 'U')).toThrowError(
      INCOMPLETE_LOGO_ERROR,
    );
    expect(resolveLogoConfig('', '')).toBeUndefined();
  });
});

describe('buildRuntimeConfig', () => {
  it('adds the logo block and keeps the bundled keys', () => {
    expect(
      buildRuntimeConfig({backendUrl: ''}, {text: 'T', imageUrl: 'U'}),
    ).toEqual({backendUrl: '', logo: {text: 'T', imageUrl: 'U'}});
  });

  it('drops a stale logo block when no logo is configured', () => {
    const result = buildRuntimeConfig(
      {backendUrl: '', logo: {text: 'old', imageUrl: 'old'}},
      undefined,
    );

    expect('logo' in result).toBe(false);
    expect(result['backendUrl']).toBe('');
  });

  it('returns the bundled keys unchanged when there is no logo either side', () => {
    expect(buildRuntimeConfig({backendUrl: ''}, undefined)).toEqual({
      backendUrl: '',
    });
  });

  it('does not mutate the base config', () => {
    const base = {backendUrl: '', logo: {text: 'old', imageUrl: 'old'}};

    buildRuntimeConfig(base, {text: 'T', imageUrl: 'U'});
    buildRuntimeConfig(base, undefined);

    expect(base).toEqual({
      backendUrl: '',
      logo: {text: 'old', imageUrl: 'old'},
    });
  });
});

describe('RUNTIME_CONFIG_RELATIVE_PATH', () => {
  it('points at the file the dev UI bundle ships', () => {
    expect(RUNTIME_CONFIG_RELATIVE_PATH.split(/[\\/]/)).toEqual([
      'assets',
      'config',
      'runtime-config.json',
    ]);
  });
});
