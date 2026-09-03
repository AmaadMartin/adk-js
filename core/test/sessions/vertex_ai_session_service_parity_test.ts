/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests ported from adk-python, so a reader can compare the two suites.
 *
 * Source: google/adk-python
 * `tests/unittests/sessions/test_vertex_ai_session_service.py`, commit
 * 856acf21e3155d2145f9af0709434dd46843539c. Each `it(...)` keeps the Python
 * test name verbatim.
 */

import {Sessions} from '@google-cloud/vertexai/build/src/genai/sessions.js';
import {createEvent, VertexAiSessionService} from '@google/adk';
import {createSession, Session} from '@google/adk/sessions/session.js';
import {logger} from '@google/adk/utils/logger.js';
import {ApiError, HttpOptions} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

/** The pause the service waits out before it retries a rate-limited append. */
const RATE_LIMIT_RETRY_DELAY_MS = 1000;

interface MockSessions {
  createInternal: ReturnType<typeof vi.fn>;
  getSessionOperationInternal: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  listInternal: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  events: {
    listInternal: ReturnType<typeof vi.fn>;
    append: ReturnType<typeof vi.fn>;
  };
}

function createMockSessions(): MockSessions {
  return {
    createInternal: vi.fn().mockResolvedValue({
      name: 'operations/test-operation-id',
      done: true,
      response: {
        name: 'projects/p/locations/l/sessions/test-id',
        sessionState: {},
        updateTime: '2024-12-12T12:12:12.123456Z',
      },
    }),
    getSessionOperationInternal: vi.fn().mockResolvedValue({done: true}),
    get: vi.fn().mockResolvedValue({
      userId: 'user',
      sessionState: {},
      updateTime: '2024-12-12T12:12:12.123456Z',
    }),
    listInternal: vi.fn().mockResolvedValue({sessions: []}),
    delete: vi.fn().mockResolvedValue({}),
    events: {
      listInternal: vi.fn().mockResolvedValue({sessionEvents: []}),
      append: vi.fn().mockResolvedValue({}),
    },
  };
}

/** Builds the session fixture appendEvent writes to. */
function appendSession(): Session {
  return createSession({
    id: 'append-session',
    appName: '123',
    userId: 'user',
    lastUpdateTime: 1734005533000,
  });
}

/** Builds `count` API events numbered from `start`, as the reference does. */
function generateEventsForPage(start: number, count: number) {
  return Array.from({length: count}, (_, index) => ({
    name: `reasoningEngines/123/sessions/pagination_test/events/e${
      start + index
    }`,
    invocationId: `invocation_${start + index}`,
    author: 'user',
    timestamp: '2024-12-12T12:12:12.123456Z',
  }));
}

describe('vertex_ai_session_service parity', () => {
  let service: VertexAiSessionService;
  let mockClient: MockSessions;

  beforeEach(() => {
    mockClient = createMockSessions();
    service = new VertexAiSessionService({
      sessions: mockClient as unknown as Sessions,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('appendEvent', () => {
    it('test_append_event_retries_once_on_429', async () => {
      mockClient.events.append
        .mockRejectedValueOnce(
          new ApiError({message: 'Resource exhausted', status: 429}),
        )
        .mockResolvedValueOnce({});
      const event = createEvent({
        invocationId: 'inv_429',
        author: 'model',
        timestamp: 1734005533000,
        content: {role: 'model', parts: [{text: 'retry test'}]},
      });
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const appended = service.appendEvent({session: appendSession(), event});
      await Promise.all([appended, vi.runAllTimersAsync()]);

      await expect(appended).resolves.toBe(event);
      expect(mockClient.events.append).toHaveBeenCalledTimes(2);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy).toHaveBeenCalledWith(
        expect.any(Function),
        RATE_LIMIT_RETRY_DELAY_MS,
      );
    });

    it('test_append_event_raises_after_retry_on_persistent_429', async () => {
      const rateLimited = new ApiError({
        message: 'Resource exhausted',
        status: 429,
      });
      mockClient.events.append.mockRejectedValue(rateLimited);
      const event = createEvent({
        invocationId: 'inv_429',
        author: 'model',
        timestamp: 1734005533000,
      });
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const appended = service.appendEvent({session: appendSession(), event});

      await Promise.all([
        expect(appended).rejects.toBe(rateLimited),
        vi.runAllTimersAsync(),
      ]);
      expect(mockClient.events.append).toHaveBeenCalledTimes(2);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy).toHaveBeenCalledWith(
        expect.any(Function),
        RATE_LIMIT_RETRY_DELAY_MS,
      );
    });

    it('test_append_event_does_not_retry_on_read_timeout', async () => {
      // A transport failure carries no `status`, and it may have persisted the
      // event, so the service must not send it again.
      const readTimeout = new Error('Read timed out');
      mockClient.events.append.mockRejectedValue(readTimeout);
      const event = createEvent({
        invocationId: 'inv_timeout',
        author: 'model',
        timestamp: 1734005533000,
      });
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      await expect(
        service.appendEvent({session: appendSession(), event}),
      ).rejects.toBe(readTimeout);

      expect(mockClient.events.append).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy).not.toHaveBeenCalled();
    });

    it('test_append_event_does_not_retry_on_non_429_client_error', async () => {
      // Divergence from the reference: adk-python asserts a single call for a
      // 400. adk-js reads a 400 as "the API does not know rawEvent" and
      // re-sends the event once without it, so the assertion pins two calls
      // and a second payload without rawEvent. The rate-limit pause stays
      // unused either way.
      const sentRawEvent: boolean[] = [];
      mockClient.events.append.mockImplementation(
        async (params: {config?: {rawEvent?: unknown}}) => {
          sentRawEvent.push(params.config?.rawEvent !== undefined);
          if (sentRawEvent.length === 1) {
            throw new ApiError({message: 'Bad request', status: 400});
          }
          return {};
        },
      );
      const event = createEvent({
        invocationId: 'inv_400',
        author: 'model',
        timestamp: 1734005533000,
      });
      const loggerSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      await service.appendEvent({session: appendSession(), event});

      loggerSpy.mockRestore();
      expect(sentRawEvent).toEqual([true, false]);
      expect(setTimeoutSpy).not.toHaveBeenCalled();
    });
  });

  describe('getSession', () => {
    it('test_get_session_pagination_keeps_client_open', async () => {
      // The reference also asserts that iteration happens inside the client's
      // `async with` block. adk-js has no client context manager, so only the
      // observable half ports: every page reaches the returned session.
      mockClient.events.listInternal
        .mockResolvedValueOnce({
          sessionEvents: generateEventsForPage(0, 100),
          nextPageToken: 'page-2',
        })
        .mockResolvedValueOnce({
          sessionEvents: generateEventsForPage(100, 100),
          nextPageToken: 'page-3',
        })
        .mockResolvedValueOnce({
          sessionEvents: generateEventsForPage(200, 50),
        });
      mockClient.get.mockResolvedValue({
        userId: 'pagination_user',
        sessionState: {},
        updateTime: '2024-12-12T12:12:12.123456Z',
      });

      const session = await service.getSession({
        appName: '123',
        userId: 'pagination_user',
        sessionId: 'pagination_test',
      });

      expect(session).toBeDefined();
      expect(session!.events).toHaveLength(250);
      expect(session!.events[0].invocationId).toBe('invocation_0');
      expect(session!.events[249].invocationId).toBe('invocation_249');
      expect(mockClient.events.listInternal).toHaveBeenCalledTimes(3);
    });

    it('test_get_session_with_page_token', async () => {
      mockClient.events.listInternal
        .mockResolvedValueOnce({
          sessionEvents: generateEventsForPage(0, 2),
          nextPageToken: 'page-2',
        })
        .mockResolvedValueOnce({sessionEvents: generateEventsForPage(2, 1)});

      const session = await service.getSession({
        appName: '123',
        userId: 'user',
        sessionId: '2',
      });

      expect(session!.events.map((event) => event.invocationId)).toEqual([
        'invocation_0',
        'invocation_1',
        'invocation_2',
      ]);
      expect(mockClient.events.listInternal).toHaveBeenNthCalledWith(2, {
        name: 'reasoningEngines/123/sessions/2',
        config: {pageToken: 'page-2'},
      });
    });
  });

  describe('createSession', () => {
    it('test_create_session_with_custom_config', async () => {
      const expireTime = '2025-12-12T12:12:12.123456Z';

      await service.createSession({
        appName: '123',
        userId: 'user',
        config: {expireTime},
      });

      expect(mockClient.createInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({expireTime}),
        }),
      );
    });
  });

  describe('apiClientHttpOptionsOverride', () => {
    it('test_api_client_http_options_override_default', () => {
      // The hook is protected, so a subclass reads it rather than the test
      // reaching into the instance.
      class ProbeService extends VertexAiSessionService {
        readOverride(): HttpOptions | undefined {
          return this.apiClientHttpOptionsOverride();
        }
      }

      const probe = new ProbeService({
        sessions: mockClient as unknown as Sessions,
      });

      expect(probe.readOverride()).toBeUndefined();
    });
  });

  describe('constructor', () => {
    it('test_initialize_with_project_location_and_api_key_error', () => {
      expect(
        () =>
          new VertexAiSessionService({
            projectId: 'test-project',
            location: 'test-location',
            expressModeApiKey: 'test-api-key',
          }),
      ).toThrow(
        'Cannot specify project or location and expressModeApiKey. ' +
          'Either use project and location, or just the expressModeApiKey.',
      );
    });
  });
});
