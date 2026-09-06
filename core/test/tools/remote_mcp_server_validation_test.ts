/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The rejection matrix of `createRemoteMcpServer`. adk-python covers the whole
 * matrix in one `pytest.raises(ValidationError)` because pydantic reports
 * every field; TypeScript needs one case per field, so these tests have no
 * counterpart in
 * `tests/unittests/agents/test_managed_agent.py`.
 */

import {InputValidationError, createRemoteMcpServer} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('createRemoteMcpServer validation', () => {
  it('rejects a missing url', () => {
    expect(() => createRemoteMcpServer({})).toThrow(
      'RemoteMcpServer.url must be a string.',
    );
  });

  it('rejects a url that is not a string', () => {
    expect(() => createRemoteMcpServer({url: 7})).toThrow(
      'RemoteMcpServer.url must be a string.',
    );
  });

  it('rejects an empty url', () => {
    expect(() => createRemoteMcpServer({url: ''})).toThrow(
      'RemoteMcpServer.url must not be empty.',
    );
  });

  it('rejects a name that is not a string', () => {
    expect(() =>
      createRemoteMcpServer({url: 'https://x/mcp', name: 7}),
    ).toThrow('RemoteMcpServer.name must be a string.');
  });

  it('rejects headers that are not a record', () => {
    expect(() =>
      createRemoteMcpServer({url: 'https://x/mcp', headers: 'nope'}),
    ).toThrow('RemoteMcpServer.headers must be a record of strings.');
  });

  it('rejects a header value that is not a string', () => {
    expect(() =>
      createRemoteMcpServer({url: 'https://x/mcp', headers: {'X-Static': 7}}),
    ).toThrow('RemoteMcpServer.headers.X-Static must be a string.');
  });

  it('rejects allowedTools that are not an array', () => {
    expect(() =>
      createRemoteMcpServer({url: 'https://x/mcp', allowedTools: 'search'}),
    ).toThrow('RemoteMcpServer.allowedTools must be an array of strings.');
  });

  it('rejects an allowedTools entry that is not a string', () => {
    expect(() =>
      createRemoteMcpServer({url: 'https://x/mcp', allowedTools: [7]}),
    ).toThrow('RemoteMcpServer.allowedTools.0 must be a string.');
  });

  it('rejects a headerProvider that is not a function', () => {
    expect(() =>
      createRemoteMcpServer({url: 'https://x/mcp', headerProvider: 'nope'}),
    ).toThrow('RemoteMcpServer.headerProvider must be a function.');
  });

  it('names every unknown key it rejects', () => {
    expect(() =>
      createRemoteMcpServer({url: 'https://x/mcp', bogus: 1, other: 2}),
    ).toThrow('RemoteMcpServer does not accept the fields: bogus, other.');
  });

  it.each([
    ['null', null],
    ['a string', 'https://x/mcp'],
    ['a number', 7],
    ['an array', []],
  ])('rejects %s as the whole description', (_label, spec) => {
    expect(() => createRemoteMcpServer(spec)).toThrow(
      'RemoteMcpServer must be an object.',
    );
  });

  it('throws InputValidationError, not a bare Error', () => {
    expect(() => createRemoteMcpServer({})).toThrow(InputValidationError);
  });
});
