/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** The resource names an API Hub path resolves to. */
export interface APIHubResourceNames {
  /** `projects/*\/locations/*\/apis/*`. */
  apiResourceName: string;
  /** `projects/*\/locations/*\/apis/*\/versions/*`, when the path names one. */
  apiVersionResourceName?: string;
  /** The spec resource name, when the path names both a version and a spec. */
  apiSpecResourceName?: string;
}

function segmentAfter(segments: string[], keyword: string): string | undefined {
  const index = segments.indexOf(keyword);
  return index === -1 ? undefined : segments[index + 1];
}

function splitPathAndProject(urlOrPath: string): {
  path: string;
  queryProject?: string;
} {
  try {
    const url = new URL(urlOrPath, 'http://localhost');
    return {
      path: url.pathname,
      queryProject: url.searchParams.get('project') ?? undefined,
    };
  } catch {
    return {path: urlOrPath};
  }
}

/**
 * Extracts the API, API version and API spec resource names from an API Hub
 * path or console URL.
 *
 * Accepts a resource path such as
 * `projects/p/locations/l/apis/a/versions/v/specs/s`, or a console URL such as
 * `https://console.cloud.google.com/apigee/api-hub/projects/p/locations/l/apis/a?project=p`.
 *
 * @param urlOrPath The API Hub path or console URL.
 * @returns The resource names the path resolves to.
 * @throws If the path names no project, no location or no API.
 */
export function extractResourceName(urlOrPath: string): APIHubResourceNames {
  const {path, queryProject} = splitPathAndProject(urlOrPath);
  const segments = path.split('/').filter((segment) => segment !== '');

  const project = segmentAfter(segments, 'projects') ?? queryProject;
  if (!project) {
    throw new Error(
      'Project ID not found in URL or path in APIHubClient. Input path is' +
        ` '${urlOrPath}'. Please make sure there is either` +
        " '/projects/PROJECT_ID' in the path or 'project=PROJECT_ID' query" +
        ' param in the input.',
    );
  }

  const location = segmentAfter(segments, 'locations');
  if (!location) {
    throw new Error(
      'Location not found in URL or path in APIHubClient. Input path is' +
        ` '${urlOrPath}'. Please make sure there is either` +
        " '/location/LOCATION_ID' in the path.",
    );
  }

  const apiId = segmentAfter(segments, 'apis');
  if (!apiId) {
    throw new Error(
      'API id not found in URL or path in APIHubClient. Input path is' +
        ` '${urlOrPath}'. Please make sure there is either '/apis/API_ID' in` +
        ' the path.',
    );
  }

  const versionId = segmentAfter(segments, 'versions');
  const specId = segmentAfter(segments, 'specs');

  const apiResourceName = `projects/${project}/locations/${location}/apis/${apiId}`;
  const apiVersionResourceName = versionId
    ? `${apiResourceName}/versions/${versionId}`
    : undefined;
  return {
    apiResourceName,
    apiVersionResourceName,
    apiSpecResourceName:
      apiVersionResourceName && specId
        ? `${apiVersionResourceName}/specs/${specId}`
        : undefined,
  };
}
