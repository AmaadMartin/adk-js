/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * adk-js only. The reference suite validates through pydantic, so it has one
 * test for the whole matrix. These cover each rejection separately.
 */

import {InputValidationError, createRemoteMcpServer} from '@google/adk';
import {describe, expect, it} from 'vitest';

const URL = 'https://mcp.example.com/mcp';

describe('createRemoteMcpServer validation', () => {
  it('rejects a missing url', () => {
    expect(() => createRemoteMcpServer({})).toThrow(InputValidationError);
    expect(() => createRemoteMcpServer({})).toThrow(
      'RemoteMcpServer.url must be a string.',
    );
  });

  it('rejects a url that is not a string', () => {
    expect(() => createRemoteMcpServer({url: 5})).toThrow(
      'RemoteMcpServer.url must be a string.',
    );
  });

  it('rejects an empty url', () => {
    expect(() => createRemoteMcpServer({url: ''})).toThrow(
      'RemoteMcpServer.url must not be empty.',
    );
  });

  it('rejects a name that is not a string', () => {
    expect(() => createRemoteMcpServer({url: URL, name: 7})).toThrow(
      'RemoteMcpServer.name must be a string.',
    );
  });

  it('rejects headers that are not a record', () => {
    expect(() => createRemoteMcpServer({url: URL, headers: 'nope'})).toThrow(
      'RemoteMcpServer.headers must be a record of strings.',
    );
  });

  it('rejects a headers array', () => {
    expect(() => createRemoteMcpServer({url: URL, headers: ['a']})).toThrow(
      'RemoteMcpServer.headers must be a record of strings.',
    );
  });

  it('rejects null headers', () => {
    expect(() => createRemoteMcpServer({url: URL, headers: null})).toThrow(
      'RemoteMcpServer.headers must be a record of strings.',
    );
  });

  it('names the header whose value is not a string', () => {
    expect(() =>
      createRemoteMcpServer({url: URL, headers: {Good: 'v', 'X-Bad': 3}}),
    ).toThrow('RemoteMcpServer.headers.X-Bad must be a string.');
  });

  it('rejects allowedTools that are not an array', () => {
    expect(() => createRemoteMcpServer({url: URL, allowedTools: 'a'})).toThrow(
      'RemoteMcpServer.allowedTools must be an array of strings.',
    );
  });

  it('names the allowedTools entry that is not a string', () => {
    expect(() =>
      createRemoteMcpServer({url: URL, allowedTools: ['a', 2]}),
    ).toThrow('RemoteMcpServer.allowedTools[1] must be a string.');
  });

  it('rejects a headerProvider that is not a function', () => {
    expect(() =>
      createRemoteMcpServer({url: URL, headerProvider: 'nope'}),
    ).toThrow('RemoteMcpServer.headerProvider must be a function.');
  });

  it('names every unknown key in one message', () => {
    const spec = {url: URL, bogus: 1, alsoBogus: 2};

    expect(() => createRemoteMcpServer(spec)).toThrow(
      'RemoteMcpServer does not accept the fields: bogus, alsoBogus.',
    );
  });

  it('accepts an explicitly undefined optional field', () => {
    const server = createRemoteMcpServer({
      url: URL,
      name: undefined,
      headers: undefined,
      allowedTools: undefined,
      headerProvider: undefined,
    });

    expect(server).toEqual({url: URL});
  });

  it('returns a copy the caller cannot reach through the argument', () => {
    const headers = {'X-Static': 'v'};
    const allowedTools = ['a'];
    const server = createRemoteMcpServer({url: URL, headers, allowedTools});
    headers['X-Static'] = 'changed';
    allowedTools.push('b');

    expect(server.headers).toEqual({'X-Static': 'v'});
    expect(server.allowedTools).toEqual(['a']);
  });

  it('accepts an empty name and an empty allowedTools list', () => {
    const server = createRemoteMcpServer({
      url: URL,
      name: '',
      allowedTools: [],
    });

    expect(server.name).toBe('');
    expect(server.allowedTools).toEqual([]);
  });
});
