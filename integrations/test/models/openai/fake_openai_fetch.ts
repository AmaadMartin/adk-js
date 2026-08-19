/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A `fetch` double for the OpenAI client.
 *
 * The client accepts a `fetch` option, so replacing it exercises the SDK's own
 * request building and server-sent-event parsing while keeping the test off
 * the network.
 */

/** One request the double observed. */
export interface RecordedRequest {
  url: string;
  headers: Headers;
  body: unknown;
}

/** A `fetch` double plus the requests it recorded. */
export interface FakeFetch {
  fetch: typeof fetch;
  requests: RecordedRequest[];
}

/** The argument types of the platform's own `fetch`. */
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

/** Reads the JSON body of an outgoing request. */
function requestBody(init?: FetchInit): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}

/** Returns the request URL, whatever form the client passed it in. */
function requestUrl(input: FetchInput): string {
  if (typeof input === 'string') {
    return input;
  }
  return 'url' in input ? input.url : input.toString();
}

/** Builds a `fetch` double that answers every request with `respond`. */
function fakeFetchWith(respond: () => Response): FakeFetch {
  const requests: RecordedRequest[] = [];
  const fetchDouble: typeof fetch = async (input, init) => {
    requests.push({
      url: requestUrl(input),
      headers: new Headers(init?.headers),
      body: requestBody(init),
    });
    return respond();
  };
  return {fetch: fetchDouble, requests};
}

/** Builds a `fetch` double that answers with one JSON response. */
export function fakeJsonFetch(payload: unknown): FakeFetch {
  return fakeFetchWith(
    () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: {'content-type': 'application/json'},
      }),
  );
}

/** Builds a `fetch` double that answers with a server-sent-event stream. */
export function fakeStreamFetch(events: unknown[]): FakeFetch {
  const body = events
    .map((event) => `event: message\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
  return fakeFetchWith(
    () =>
      new Response(body, {
        status: 200,
        headers: {'content-type': 'text/event-stream'},
      }),
  );
}
