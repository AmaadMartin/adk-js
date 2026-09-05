/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  InvocationContext,
  LlmAgent,
  RunnableRoot,
} from '@google/adk';
import {ServerAgentLoader} from '../../src/server/adk_api_server.js';

/** An agent that answers without reaching a model. */
export class StubAgent extends LlmAgent {
  async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {parts: [{text: 'Hello'}], role: 'model'},
    });
  }
}

/**
 * Builds a loader that serves one agent under one app name, so a test can
 * start a real server without an agents directory on disk.
 */
export function createStubAgentLoader(
  appName: string,
  agent: RunnableRoot = new StubAgent({name: 'stubAgent'}),
): ServerAgentLoader {
  return {
    listAgents: () => Promise.resolve([appName]),
    getAgentFile: () =>
      Promise.resolve({
        load: () => Promise.resolve(agent),
        async [Symbol.asyncDispose](): Promise<void> {},
      }),
  };
}

/** The status and parsed JSON body of one request. */
export interface JsonResponse<T> {
  status: number;
  body: T;
}

/** Issues a GET and reads the response as JSON. */
export async function getJson<T>(url: string): Promise<JsonResponse<T>> {
  const response = await fetch(url, {redirect: 'manual'});
  return {status: response.status, body: (await response.json()) as T};
}

/** Issues a GET and reports only the status, for responses with no JSON body. */
export async function getStatus(url: string): Promise<number> {
  const response = await fetch(url, {redirect: 'manual'});
  await response.arrayBuffer();
  return response.status;
}

/** Issues a POST with a JSON body and reads the response as JSON. */
export async function postJson<T>(
  url: string,
  body: unknown,
): Promise<JsonResponse<T>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
  return {status: response.status, body: (await response.json()) as T};
}
