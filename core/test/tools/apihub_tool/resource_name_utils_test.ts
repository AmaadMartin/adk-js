/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
// Not part of the package's public surface, so it is imported by path.
import {extractResourceName} from '../../../src/tools/apihub_tool/resource_name_utils.js';

describe('extractResourceName', () => {
  it.each([
    [
      'projects/test-project/locations/us-central1/apis/api1',
      {
        apiResourceName:
          'projects/test-project/locations/us-central1/apis/api1',
        apiVersionResourceName: undefined,
        apiSpecResourceName: undefined,
      },
    ],
    [
      'projects/test-project/locations/us-central1/apis/api1/versions/v1',
      {
        apiResourceName:
          'projects/test-project/locations/us-central1/apis/api1',
        apiVersionResourceName:
          'projects/test-project/locations/us-central1/apis/api1/versions/v1',
        apiSpecResourceName: undefined,
      },
    ],
    [
      'projects/test-project/locations/us-central1/apis/api1/versions/v1/specs/spec1',
      {
        apiResourceName:
          'projects/test-project/locations/us-central1/apis/api1',
        apiVersionResourceName:
          'projects/test-project/locations/us-central1/apis/api1/versions/v1',
        apiSpecResourceName:
          'projects/test-project/locations/us-central1/apis/api1/versions/v1/specs/spec1',
      },
    ],
    [
      'https://console.cloud.google.com/apigee/api-hub/projects/test-project/locations/us-central1/apis/api1/versions/v1?project=test-project',
      {
        apiResourceName:
          'projects/test-project/locations/us-central1/apis/api1',
        apiVersionResourceName:
          'projects/test-project/locations/us-central1/apis/api1/versions/v1',
        apiSpecResourceName: undefined,
      },
    ],
    [
      'https://console.cloud.google.com/apigee/api-hub/projects/test-project/locations/us-central1/apis/api1/versions/v1/specs/spec1?project=test-project',
      {
        apiResourceName:
          'projects/test-project/locations/us-central1/apis/api1',
        apiVersionResourceName:
          'projects/test-project/locations/us-central1/apis/api1/versions/v1',
        apiSpecResourceName:
          'projects/test-project/locations/us-central1/apis/api1/versions/v1/specs/spec1',
      },
    ],
    [
      '/projects/test-project/locations/us-central1/apis/api1/versions/v1',
      {
        apiResourceName:
          'projects/test-project/locations/us-central1/apis/api1',
        apiVersionResourceName:
          'projects/test-project/locations/us-central1/apis/api1/versions/v1',
        apiSpecResourceName: undefined,
      },
    ],
    [
      'projects/test-project/locations/us-central1/apis/api1/',
      {
        apiResourceName:
          'projects/test-project/locations/us-central1/apis/api1',
        apiVersionResourceName: undefined,
        apiSpecResourceName: undefined,
      },
    ],
    [
      'projects/test-project/locations/LOCATION/apis/api1/',
      {
        apiResourceName: 'projects/test-project/locations/LOCATION/apis/api1',
        apiVersionResourceName: undefined,
        apiSpecResourceName: undefined,
      },
    ],
    [
      'projects/p1/locations/l1/apis/a1/versions/v1/specs/s1',
      {
        apiResourceName: 'projects/p1/locations/l1/apis/a1',
        apiVersionResourceName: 'projects/p1/locations/l1/apis/a1/versions/v1',
        apiSpecResourceName:
          'projects/p1/locations/l1/apis/a1/versions/v1/specs/s1',
      },
    ],
  ])('extracts the resource names of %s', (urlOrPath, expected) => {
    expect(extractResourceName(urlOrPath)).toEqual(expected);
  });

  it('reads the project from the query when the path has none', () => {
    expect(
      extractResourceName(
        'https://console.cloud.google.com/apigee/api-hub/locations/us-central1/apis/api1?project=test-project',
      ),
    ).toEqual({
      apiResourceName: 'projects/test-project/locations/us-central1/apis/api1',
      apiVersionResourceName: undefined,
      apiSpecResourceName: undefined,
    });
  });

  it('ignores a spec id that comes without a version id', () => {
    expect(
      extractResourceName('projects/p1/locations/l1/apis/a1/specs/s1')
        .apiSpecResourceName,
    ).toBeUndefined();
  });

  it('falls back to the raw input when it does not parse as a URL', () => {
    expect(() => extractResourceName('http://[')).toThrow(
      "Project ID not found in URL or path in APIHubClient. Input path is 'http://['.",
    );
  });

  it.each([
    ['invalid-path', 'Project ID not found in URL or path in APIHubClient.'],
    [
      'projects/test-project',
      'Location not found in URL or path in APIHubClient.',
    ],
    [
      'projects/test-project/locations/us-central1',
      'API id not found in URL or path in APIHubClient.',
    ],
  ])('rejects %s', (urlOrPath, expectedMessage) => {
    expect(() => extractResourceName(urlOrPath)).toThrow(expectedMessage);
  });
});
