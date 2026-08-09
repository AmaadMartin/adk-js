/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getClientLabels, runWithClientLabel} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseUserAgent} from '../../src/utils/client_labels.js';

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

  describe('runWithClientLabel with an async generator callback', () => {
    const label = 'generator-label';
    const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

    async function* labelProbe(): AsyncGenerator<string[], void> {
      yield getClientLabels();
      await tick();
      yield getClientLabels();
    }

    it('should apply the label at the first yield', async () => {
      const generator = runWithClientLabel(label, () => labelProbe());

      const first = await generator.next();

      expect(first.value).toContain(label);
      expect(first.value).toHaveLength(3);
    });

    it('should keep the label across an await inside the body', async () => {
      const generator = runWithClientLabel(label, () => labelProbe());

      await generator.next();
      const second = await generator.next();

      expect(second.value).toContain(label);
    });

    it('should apply the label when consumed with for await', async () => {
      const seen: string[][] = [];

      for await (const labels of runWithClientLabel(label, () =>
        labelProbe(),
      )) {
        seen.push(labels);
      }

      expect(seen).toHaveLength(2);
      expect(seen[0]).toContain(label);
      expect(seen[1]).toContain(label);
    });

    it('should run a finally block reached by an early break inside the label scope', async () => {
      let captured: string[] = [];
      async function* withCleanup(): AsyncGenerator<number, void> {
        try {
          yield 1;
          await tick();
          yield 2;
        } finally {
          captured = getClientLabels();
        }
      }

      for await (const _value of runWithClientLabel(label, () =>
        withCleanup(),
      )) {
        break;
      }

      expect(captured).toContain(label);
    });

    it('should resume inside the label scope when throw() is called', async () => {
      let captured: string[] = [];
      async function* withCatch(): AsyncGenerator<number, void> {
        try {
          yield 1;
        } catch {
          captured = getClientLabels();
          yield 2;
        }
      }

      const generator = runWithClientLabel(label, () => withCatch());
      await generator.next();
      const resumed = await generator.throw(new Error('boom'));

      expect(captured).toContain(label);
      expect(resumed.value).toBe(2);
    });

    it('should pass through the return value of the generator', async () => {
      async function* withReturnValue(): AsyncGenerator<number, string> {
        yield 1;
        return 'done';
      }

      const generator = runWithClientLabel(label, () => withReturnValue());
      await generator.next();
      const final = await generator.next();

      expect(final).toEqual({done: true, value: 'done'});
    });

    it('should propagate an error thrown by the generator body', async () => {
      async function* failing(): AsyncGenerator<number, void> {
        yield 1;
        throw new Error('generator failed');
      }

      const generator = runWithClientLabel(label, () => failing());
      await generator.next();

      await expect(generator.next()).rejects.toThrow('generator failed');
    });

    it('should not leak the label after the generator is drained', async () => {
      for await (const _labels of runWithClientLabel(label, () =>
        labelProbe(),
      )) {
        // drain
      }

      const labels = getClientLabels();
      expect(labels).not.toContain(label);
      expect(labels).toHaveLength(2);
    });

    it('should keep interleaved generators on their own labels', async () => {
      const first = runWithClientLabel('label-a', () => labelProbe());
      const second = runWithClientLabel('label-b', () => labelProbe());

      const firstStart = await first.next();
      const secondStart = await second.next();
      const firstEnd = await first.next();
      const secondEnd = await second.next();

      expect(firstStart.value).toContain('label-a');
      expect(secondStart.value).toContain('label-b');
      expect(firstEnd.value).toContain('label-a');
      expect(secondEnd.value).toContain('label-b');
      expect(firstEnd.value).not.toContain('label-b');
      expect(secondEnd.value).not.toContain('label-a');
    });

    it('should return a non-generator result unchanged', () => {
      const promise = Promise.resolve('resolved');

      expect(runWithClientLabel(label, () => 42)).toBe(42);
      expect(runWithClientLabel(label, () => null)).toBeNull();
      expect(runWithClientLabel(label, () => undefined)).toBeUndefined();
      expect(runWithClientLabel(label, () => promise)).toBe(promise);
    });

    it('should not wrap a sync iterable', () => {
      const items = [1, 2];

      expect(runWithClientLabel(label, () => items)).toBe(items);
    });

    it('should not wrap an async iterable that is not a generator', async () => {
      const asyncIterable = {
        async *[Symbol.asyncIterator]() {
          yield getClientLabels();
        },
      };

      expect(runWithClientLabel(label, () => asyncIterable)).toBe(
        asyncIterable,
      );
    });
  });
});
