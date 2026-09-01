/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {VertexAiCodeInterpreterExtensionClient} from '../../src/code_executors/code_interpreter_extension_client.js';

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn(() => ({
    getClient: vi.fn(async () => ({
      getRequestHeaders: vi.fn(
        async () => new Headers({Authorization: 'Bearer fake-token'}),
      ),
    })),
  })),
}));

const RESOURCE_NAME =
  'projects/test-project/locations/europe-west4/extensions/456';
const OPERATION_NAME =
  'projects/test-project/locations/us-central1/operations/1';
const CREATED_RESOURCE_NAME =
  'projects/test-project/locations/us-central1/extensions/789';

/**
 * Comfortably longer than the client's poll budget, which is 180 attempts one
 * second apart. Fake timers only run the timers the client schedules, so an
 * over-large value costs nothing.
 */
const POLL_BUDGET_MS = 600_000;

/**
 * A fresh `Response` per call: a body can only be read once, so a mock that
 * resolves to one shared instance breaks as soon as `fetch` runs twice.
 */
function jsonResponder(body: unknown): () => Response {
  return () => new Response(JSON.stringify(body), {status: 200});
}

/**
 * The second argument the client passes to `fetch`. Spelled out here because
 * the DOM's `RequestInit` is a type-only global that the lint rules reject.
 */
interface RecordedInit {
  method?: string;
  headers?: Headers;
  body?: string;
}

type FetchMock = Mock<(url: string, init: RecordedInit) => Response>;

/** The request the stubbed `fetch` recorded, with its body already parsed. */
function recordedCall(
  fetchMock: FetchMock,
  index: number,
): {url: string; init: RecordedInit; body: unknown} {
  const [url, init] = fetchMock.mock.calls[index];
  return {
    url,
    init,
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  };
}

describe('VertexAiCodeInterpreterExtensionClient', () => {
  let fetchMock: FetchMock;
  let client: VertexAiCodeInterpreterExtensionClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = new VertexAiCodeInterpreterExtensionClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('execute', () => {
    it('posts the execute operation to the extension', async () => {
      fetchMock.mockImplementation(
        jsonResponder({content: JSON.stringify({execution_result: 'hi'})}),
      );

      await client.execute(RESOURCE_NAME, {
        code: 'print(1)',
        files: [{name: 'a.csv', contents: 'AAA='}],
        sessionId: 'session-1',
      });

      const {url, init, body} = recordedCall(fetchMock, 0);
      expect(url).toBe(
        `https://europe-west4-aiplatform.googleapis.com/v1beta1/${RESOURCE_NAME}:execute`,
      );
      expect(init.method).toBe('POST');
      expect(init.headers?.get('Authorization')).toBe('Bearer fake-token');
      expect(body).toEqual({
        operationId: 'execute',
        operationParams: {
          code: 'print(1)',
          files: [{name: 'a.csv', contents: 'AAA='}],
          session_id: 'session-1',
        },
      });
    });

    it('leaves files and session_id out when they are unset', async () => {
      fetchMock.mockImplementation(jsonResponder({content: '{}'}));

      await client.execute(RESOURCE_NAME, {code: 'print(1)'});

      const {body} = recordedCall(fetchMock, 0);
      expect(body).toEqual({
        operationId: 'execute',
        operationParams: {code: 'print(1)'},
      });
    });

    it('parses the content envelope', async () => {
      fetchMock.mockImplementation(
        jsonResponder({
          content: JSON.stringify({
            execution_result: 'hello',
            output_files: [{name: 'plot.png', contents: 'AAA='}],
          }),
        }),
      );

      const response = await client.execute(RESOURCE_NAME, {code: 'print(1)'});

      expect(response).toEqual({
        execution_result: 'hello',
        output_files: [{name: 'plot.png', contents: 'AAA='}],
      });
    });

    it('rejects a malformed resource name', async () => {
      await expect(
        client.execute('extensions/456', {code: 'print(1)'}),
      ).rejects.toThrow(
        'Invalid code interpreter extension resource name: extensions/456',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports the status and the body of a failed request', async () => {
      fetchMock.mockImplementation(
        () => new Response('permission denied', {status: 403}),
      );

      await expect(
        client.execute(RESOURCE_NAME, {code: 'print(1)'}),
      ).rejects.toThrow(
        'API request failed with status 403: permission denied',
      );
    });
  });

  describe('importFromHub', () => {
    it('imports the public manifest and returns the extension name', async () => {
      fetchMock.mockImplementation(
        jsonResponder({
          name: OPERATION_NAME,
          done: true,
          response: {name: CREATED_RESOURCE_NAME},
        }),
      );

      const name = await client.importFromHub('test-project', 'us-central1');

      expect(name).toBe(CREATED_RESOURCE_NAME);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const {url, init, body} = recordedCall(fetchMock, 0);
      expect(url).toBe(
        'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/test-project/locations/us-central1/extensions:import',
      );
      expect(init.method).toBe('POST');
      expect(body).toEqual({
        displayName: 'Code Interpreter',
        description:
          'This extension generates and executes code in the specified language',
        manifest: {
          name: 'code_interpreter_tool',
          description:
            'This extension generates and executes code in the specified language',
          apiSpec: {
            openApiGcsUri: 'gs://vertex-extension-public/code_interpreter.yaml',
          },
          authConfig: {
            authType: 'GOOGLE_SERVICE_ACCOUNT_AUTH',
            googleServiceAccountConfig: {},
          },
        },
      });
    });

    it('polls the operation until it is done', async () => {
      vi.useFakeTimers();
      fetchMock
        .mockImplementationOnce(jsonResponder({name: OPERATION_NAME}))
        .mockImplementationOnce(jsonResponder({name: OPERATION_NAME}))
        .mockImplementationOnce(
          jsonResponder({
            name: OPERATION_NAME,
            done: true,
            response: {name: CREATED_RESOURCE_NAME},
          }),
        );

      const pending = client.importFromHub('test-project', 'us-central1');
      await vi.advanceTimersByTimeAsync(POLL_BUDGET_MS);

      await expect(pending).resolves.toBe(CREATED_RESOURCE_NAME);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const {url, init} = recordedCall(fetchMock, 1);
      expect(url).toBe(
        `https://us-central1-aiplatform.googleapis.com/v1beta1/${OPERATION_NAME}`,
      );
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
    });

    it('reports an operation that finished with an error', async () => {
      fetchMock.mockImplementation(
        jsonResponder({
          name: OPERATION_NAME,
          done: true,
          error: {message: 'quota exceeded'},
        }),
      );

      await expect(
        client.importFromHub('test-project', 'us-central1'),
      ).rejects.toThrow(
        `Extension import operation ${OPERATION_NAME} failed: quota exceeded`,
      );
    });

    it('reports an operation that finished without an extension', async () => {
      fetchMock.mockImplementation(
        jsonResponder({name: OPERATION_NAME, done: true, response: {}}),
      );

      await expect(
        client.importFromHub('test-project', 'us-central1'),
      ).rejects.toThrow(
        `Extension import operation ${OPERATION_NAME} returned no extension.`,
      );
    });

    it('gives up once the poll budget is exhausted', async () => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(jsonResponder({name: OPERATION_NAME}));

      const pending = client.importFromHub('test-project', 'us-central1');
      const assertion = expect(pending).rejects.toThrow(
        `Extension import operation ${OPERATION_NAME} did not complete in time.`,
      );
      await vi.advanceTimersByTimeAsync(POLL_BUDGET_MS);

      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(181);
    });

    it('reports the status and the body of a failed import', async () => {
      fetchMock.mockImplementation(
        () => new Response('bad request', {status: 400}),
      );

      await expect(
        client.importFromHub('test-project', 'us-central1'),
      ).rejects.toThrow('API request failed with status 400: bad request');
    });
  });
});
