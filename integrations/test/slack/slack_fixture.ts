/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '@google/adk';
import {webApi} from '@slack/bolt';
import {createServer} from 'node:http';
import {expect, vi} from 'vitest';

export const EVENT_TS = '1234567890.123456';
export const THINKING_TS = 'thinking_ts';
export const CHANNEL = 'C67890';
export const USER = 'U12345';
export const APP_NAME = 'slack_test_app';
export const AGENT_NAME = 'slack_test_agent';

/** A real Runner whose agent is never reached once `runAsync` is stubbed. */
export function createRunner(): Runner {
  return new Runner({
    appName: APP_NAME,
    agent: new LlmAgent({name: AGENT_NAME, model: 'gemini-2.5-flash'}),
    sessionService: new InMemorySessionService(),
  });
}

/** An agent event carrying one text part, as the model would produce. */
export function modelEvent(text: string): Event {
  return createEvent({
    invocationId: 'inv',
    author: AGENT_NAME,
    content: {role: 'model', parts: [{text}]},
  });
}

/** An agent event whose single part carries no text. */
export function nonTextEvent(): Event {
  return createEvent({
    invocationId: 'inv',
    author: AGENT_NAME,
    content: {role: 'model', parts: [{thought: true}]},
  });
}

/** An agent event with no content at all. */
export function emptyEvent(): Event {
  return createEvent({invocationId: 'inv', author: AGENT_NAME});
}

/**
 * Builds the stream `Runner.runAsync` returns.
 *
 * @param events The events to yield. Anything that is not an array is thrown
 *   instead, so a test can drive the error path with a non-Error value too.
 * @return A generator function suitable for `mockImplementation`.
 */
export function streamOf(
  events: Event[] | Error | string,
): () => AsyncGenerator<Event, void, void> {
  return async function* stream(): AsyncGenerator<Event, void, void> {
    if (!Array.isArray(events)) throw events;
    for (const event of events) yield event;
  };
}

/**
 * A real `Runner` and a real `WebClient`, with only the network calls stubbed.
 *
 * @return The runner, client, `say` double and the spies asserted against.
 */
export function createSlackFixture() {
  const runner = createRunner();
  const client = new webApi.WebClient('test-bot-token');
  return {
    runner,
    client,
    runAsync: vi.spyOn(runner, 'runAsync'),
    update: vi.spyOn(client.chat, 'update').mockResolvedValue({ok: true}),
    remove: vi.spyOn(client.chat, 'delete').mockResolvedValue({ok: true}),
    say: vi.fn(async () => ({ok: true, ts: THINKING_TS})),
  };
}

/** One request the Bolt client made against the fake Slack Web API. */
export interface SlackApiCall {
  /** The Web API method, for example `chat.postMessage`. */
  method: string;
  /** The form-encoded request body, decoded into fields. */
  params: Record<string, string>;
}

/** A local stand-in for the Slack Web API, recording what Bolt sends it. */
export interface FakeSlackApi {
  /** The `slackApiUrl` to hand to Bolt's client options. */
  url: string;
  /** Every call received, in order. */
  calls: SlackApiCall[];
  /** Shuts the server down. */
  close(): Promise<void>;
}

/**
 * Starts a local HTTP server that answers Slack Web API calls with `ok`.
 *
 * Bolt's real `WebClient` talks to it over real HTTP, so a test can drive the
 * whole listener path without stubbing anything inside Bolt.
 *
 * @return The server URL, the recorded calls, and a shutdown function.
 */
export async function startFakeSlackApi(): Promise<FakeSlackApi> {
  const calls: SlackApiCall[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      calls.push({
        method: (req.url ?? '').replace('/api/', ''),
        params: Object.fromEntries(new URLSearchParams(body)),
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ok: true, ts: THINKING_TS}));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address();
  if (address === null || typeof address === 'string') {
    expect.fail('fake Slack API did not bind a TCP port');
  }
  return {
    url: `http://127.0.0.1:${address.port}/api/`,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
