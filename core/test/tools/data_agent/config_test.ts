/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * adk-python declares `DataAgentToolConfig` as a pydantic model, so its
 * defaults and its two `gt=0` constraints have no test of their own there.
 * `resolveDataAgentToolConfig` does that work here, so it has one.
 */

import {resolveDataAgentToolConfig} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('resolveDataAgentToolConfig', () => {
  it('fills in every default when it is given nothing', () => {
    expect(resolveDataAgentToolConfig()).toEqual({
      location: undefined,
      apiEndpoint: undefined,
      maxQueryResultRows: 50,
      dataAgentModificationTimeoutSeconds: 60,
      dataAgentModificationPollIntervalSeconds: 2,
      enableDataAgentModification: false,
    });
  });

  it('keeps every value the caller set', () => {
    expect(
      resolveDataAgentToolConfig({
        location: 'eu',
        apiEndpoint: 'https://gda.test',
        maxQueryResultRows: 100,
        dataAgentModificationTimeoutSeconds: 5,
        dataAgentModificationPollIntervalSeconds: 1,
        enableDataAgentModification: true,
      }),
    ).toEqual({
      location: 'eu',
      apiEndpoint: 'https://gda.test',
      maxQueryResultRows: 100,
      dataAgentModificationTimeoutSeconds: 5,
      dataAgentModificationPollIntervalSeconds: 1,
      enableDataAgentModification: true,
    });
  });

  it.each([0, -1])(
    'rejects a modification timeout of %i seconds',
    (seconds) => {
      expect(() =>
        resolveDataAgentToolConfig({
          dataAgentModificationTimeoutSeconds: seconds,
        }),
      ).toThrow(
        `dataAgentModificationTimeoutSeconds must be greater than zero, got: ${seconds}`,
      );
    },
  );

  it.each([0, -1])('rejects a poll interval of %i seconds', (seconds) => {
    expect(() =>
      resolveDataAgentToolConfig({
        dataAgentModificationPollIntervalSeconds: seconds,
      }),
    ).toThrow(
      `dataAgentModificationPollIntervalSeconds must be greater than zero, got: ${seconds}`,
    );
  });

  it('rejects a timeout that is not a number at all', () => {
    expect(() =>
      resolveDataAgentToolConfig({
        dataAgentModificationTimeoutSeconds: Number.NaN,
      }),
    ).toThrow('dataAgentModificationTimeoutSeconds must be greater than zero');
  });
});
