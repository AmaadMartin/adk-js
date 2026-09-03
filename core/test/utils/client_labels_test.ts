/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getClientLabels, runWithClientLabel} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  getTrackingHeaders,
  mergeTrackingHeaders,
  parseUserAgent,
} from '../../src/utils/client_labels.js';

describe('client_labels', () => {
  describe('parseUserAgent', () => {
    it('should parse Chrome UA', () => {
      const ua =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
      expect(parseUserAgent(ua)).toBe('Chrome/123.0.0.0');
    });

    it('should parse Chrome iOS UA', () => {
      const ua =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.6312.52 Mobile/15E148 Safari/604.1';
      expect(parseUserAgent(ua)).toBe('Chrome/123.0.6312.52');
    });

    it('should parse Firefox UA', () => {
      const ua =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0';
      expect(parseUserAgent(ua)).toBe('Firefox/123.0');
    });

    it('should parse Firefox iOS UA', () => {
      const ua =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/123.0 Mobile/15E148 Safari/605.1.15';
      expect(parseUserAgent(ua)).toBe('Firefox/123.0');
    });

    it('should parse Edge UA', () => {
      const ua =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0';
      expect(parseUserAgent(ua)).toBe('Edge/123.0.0.0');
    });

    it('should parse Safari UA', () => {
      const ua =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15';
      expect(parseUserAgent(ua)).toBe('Safari/17.3');
    });

    it('should fallback to Browser for unknown UA', () => {
      expect(parseUserAgent('Unknown UA')).toBe('Browser');
      expect(parseUserAgent('')).toBe('Browser');
    });
  });

  describe('getClientLabels', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = {...originalEnv};
    });

    afterEach(() => {
      process.env = originalEnv;
      vi.restoreAllMocks();
    });

    it('should return an array of label strings', () => {
      const labels = getClientLabels();
      expect(Array.isArray(labels)).toBe(true);
      expect(labels.length).toBeGreaterThan(0);
    });

    it('should include google-adk label with version', () => {
      const labels = getClientLabels();
      const adkLabel = labels.find((l) => l.startsWith('google-adk/'));
      expect(adkLabel).toBeDefined();
    });

    it('should include gl-typescript language label', () => {
      const labels = getClientLabels();
      const langLabel = labels.find((l) => l.startsWith('gl-typescript/'));
      expect(langLabel).toBeDefined();
    });

    it('should include agent engine telemetry tag when env variable is set', () => {
      process.env['GOOGLE_CLOUD_AGENT_ENGINE_ID'] = 'my-engine-id';
      const labels = getClientLabels();
      const adkLabel = labels.find((l) => l.startsWith('google-adk/'));
      expect(adkLabel).toContain('remote_reasoning_engine');
    });

    it('should not include agent engine telemetry tag when env variable is not set', () => {
      delete process.env['GOOGLE_CLOUD_AGENT_ENGINE_ID'];
      const labels = getClientLabels();
      const adkLabel = labels.find((l) => l.startsWith('google-adk/'));
      expect(adkLabel).not.toContain('remote_reasoning_engine');
    });

    it('should return exactly two labels in Node.js environment by default', () => {
      const labels = getClientLabels();
      expect(labels).toHaveLength(2);
    });
  });

  describe('runWithClientLabel', () => {
    it('should append custom label in context', () => {
      const customLabel = 'my-custom-label';
      runWithClientLabel(customLabel, () => {
        const labels = getClientLabels();
        expect(labels).toContain(customLabel);
        expect(labels).toHaveLength(3);
      });
    });

    it('should clean up custom label after callback', () => {
      const customLabel = 'my-custom-label';
      runWithClientLabel(customLabel, () => {
        // inside
      });
      const labels = getClientLabels();
      expect(labels).not.toContain(customLabel);
      expect(labels).toHaveLength(2);
    });

    it('should propagate label across async hops', async () => {
      const customLabel = 'async-label';
      await runWithClientLabel(customLabel, async () => {
        expect(getClientLabels()).toContain(customLabel);

        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(getClientLabels()).toContain(customLabel);

        await Promise.resolve();
        expect(getClientLabels()).toContain(customLabel);
      });
    });

    it('should throw error for empty label', () => {
      expect(() => {
        runWithClientLabel('', () => {});
      }).toThrow('Client label must be a non-empty string.');

      expect(() => {
        runWithClientLabel('   ', () => {});
      }).toThrow('Client label must be a non-empty string.');
    });
  });

  describe('getTrackingHeaders', () => {
    it('sends the same joined labels under both header names', () => {
      const headers = getTrackingHeaders();

      expect(Object.keys(headers).sort()).toEqual([
        'user-agent',
        'x-goog-api-client',
      ]);
      expect(headers['user-agent']).toBe(getClientLabels().join(' '));
      expect(headers['x-goog-api-client']).toBe(headers['user-agent']);
    });
  });

  describe('mergeTrackingHeaders', () => {
    it('returns exactly the tracking headers for an absent input', () => {
      expect(mergeTrackingHeaders()).toEqual(getTrackingHeaders());
    });

    it('keeps a custom header the tracking headers do not name', () => {
      expect(mergeTrackingHeaders({'x-request-id': 'abc'})).toEqual({
        ...getTrackingHeaders(),
        'x-request-id': 'abc',
      });
    });

    it('appends a custom value after the tracking labels', () => {
      const tracking = getTrackingHeaders()['x-goog-api-client'];

      const merged = mergeTrackingHeaders({'x-goog-api-client': 'my-app/1.0'});

      expect(merged['x-goog-api-client']).toBe(`${tracking} my-app/1.0`);
    });

    it('replaces an empty custom value rather than appending to it', () => {
      const merged = mergeTrackingHeaders({'user-agent': ''});

      expect(merged['user-agent']).toBe(getTrackingHeaders()['user-agent']);
    });

    it('does not repeat a label the custom value already carries', () => {
      const tracking = getTrackingHeaders()['x-goog-api-client'];
      const [adkLabel] = tracking.split(' ');

      const merged = mergeTrackingHeaders({
        'x-goog-api-client': `${adkLabel} my-app/1.0`,
      });

      expect(merged['x-goog-api-client']).toBe(`${tracking} my-app/1.0`);
    });

    it('does not modify the headers it was given', () => {
      const headers = {'x-goog-api-client': 'my-app/1.0'};

      mergeTrackingHeaders(headers);

      expect(headers).toEqual({'x-goog-api-client': 'my-app/1.0'});
    });

    it.each([[undefined], [{}]])('adds both headers to %j', (headers) => {
      expect(mergeTrackingHeaders(headers)).toEqual(getTrackingHeaders());
    });

    it('keeps a header it does not own', () => {
      expect(mergeTrackingHeaders({custom: 'header'})['custom']).toBe('header');
    });

    it('never mutates the headers it was given', () => {
      const headers = {custom: 'header'};

      mergeTrackingHeaders(headers);

      expect(headers).toEqual({custom: 'header'});
    });

    it('appends the tracking parts to a value a caller already set', () => {
      const merged = mergeTrackingHeaders({'user-agent': 'my-client/1.0'});

      const parts = merged['user-agent'].split(' ');
      expect(parts).toContain('my-client/1.0');
      expect(parts.slice(0, -1).join(' ')).toBe(
        getTrackingHeaders()['user-agent'],
      );
    });

    it('does not repeat a part the caller value already carries', () => {
      const tracked = getTrackingHeaders()['user-agent'];

      const merged = mergeTrackingHeaders({'user-agent': tracked});

      expect(merged['user-agent']).toBe(tracked);
    });

    it('replaces an empty value rather than appending to it', () => {
      expect(mergeTrackingHeaders({'user-agent': ''})).toEqual(
        getTrackingHeaders(),
      );
    });
  });
});
