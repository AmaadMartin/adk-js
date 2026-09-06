/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {UserInputRequest} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  buildInterruptResponse,
  parseConfirmationResponse,
  parseInputResponse,
} from '../../src/cli/hitl_response.js';

describe('parseInputResponse', () => {
  it('uses a JSON object as the response itself', () => {
    expect(parseInputResponse('{"city":"Paris","days":2}')).toEqual({
      city: 'Paris',
      days: 2,
    });
  });

  it.each([
    ['42', 42],
    ['"Paris"', 'Paris'],
    ['true', true],
    ['null', null],
    ['[1,2]', [1, 2]],
  ])('carries the JSON scalar %s under result', (answer, expected) => {
    expect(parseInputResponse(answer)).toEqual({result: expected});
  });

  it('carries text that is not JSON under result', () => {
    expect(parseInputResponse('Paris, please')).toEqual({
      result: 'Paris, please',
    });
  });
});

describe('parseConfirmationResponse', () => {
  it.each([
    ['y', true],
    ['yes', true],
    ['YES', true],
    [' Yes ', true],
    ['confirm', true],
    ['Confirm', true],
    ['n', false],
    ['no', false],
    ['nope', false],
    ['', false],
    ['yes please', false],
    ['ok', false],
  ])('reads the plain answer %o as confirmed=%s', (answer, confirmed) => {
    expect(parseConfirmationResponse(answer)).toEqual({confirmed});
  });

  it.each([
    ['true', true],
    ['false', false],
    ['1', false],
  ])('reads the JSON scalar %s as confirmed=%s', (answer, confirmed) => {
    expect(parseConfirmationResponse(answer)).toEqual({confirmed});
  });

  it('passes a JSON object through as the response', () => {
    expect(
      parseConfirmationResponse('{"confirmed":true,"scope":"today"}'),
    ).toEqual({confirmed: true, scope: 'today'});
  });
});

describe('buildInterruptResponse', () => {
  const request = (
    kind: UserInputRequest['kind'],
    functionCallName: string,
  ): UserInputRequest => ({
    kind,
    interruptId: 'interrupt-1',
    functionCallName,
  });

  it('answers an input request under its own name', () => {
    expect(
      buildInterruptResponse(request('input', 'adk_request_input'), 'Paris'),
    ).toEqual({
      functionResponse: {
        id: 'interrupt-1',
        name: 'adk_request_input',
        response: {result: 'Paris'},
      },
    });
  });

  it('answers a confirmation request under its own name', () => {
    expect(
      buildInterruptResponse(
        request('confirmation', 'adk_request_confirmation'),
        'yes',
      ),
    ).toEqual({
      functionResponse: {
        id: 'interrupt-1',
        name: 'adk_request_confirmation',
        response: {confirmed: true},
      },
    });
  });

  it('answers a credential request as an input request', () => {
    expect(
      buildInterruptResponse(
        request('credential', 'adk_request_credential'),
        'a-token',
      ),
    ).toEqual({
      functionResponse: {
        id: 'interrupt-1',
        name: 'adk_request_input',
        response: {result: 'a-token'},
      },
    });
  });
});
