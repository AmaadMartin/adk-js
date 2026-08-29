/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleApiToOpenApiConverter} from '@google/adk';

/** Where the converted specification is written when none is named. */
export const DEFAULT_OUTPUT_PATH = 'openapi_spec.json';

/** What to convert, and where to put the result. */
export interface ConvertGoogleApiOptions {
  /** The Discovery API id, e.g. `calendar`. */
  apiName: string;
  /** The API version, e.g. `v3`. */
  apiVersion: string;
  /** The file to write the OpenAPI 3.0 document to. */
  output: string;
}

/**
 * Converts a Google API Discovery document into an OpenAPI 3.0 file.
 *
 * @throws If the Discovery document cannot be fetched or the file cannot be
 *     written. The caller reports it and sets the exit status.
 */
export async function convertGoogleApi(
  options: ConvertGoogleApiOptions,
): Promise<void> {
  const converter = new GoogleApiToOpenApiConverter(
    options.apiName,
    options.apiVersion,
  );
  await converter.convert();
  await converter.saveOpenApiSpec(options.output);
}
