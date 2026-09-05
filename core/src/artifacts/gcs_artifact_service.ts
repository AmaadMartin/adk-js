/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Bucket,
  File,
  FileMetadata,
  GetSignedUrlConfig,
  StorageOptions,
} from '@google-cloud/storage';
import {createPartFromBase64, createPartFromText, Part} from '@google/genai';
import {InputValidationError} from '../errors/input_validation_error.js';
import {logger} from '../utils/logger.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';

import {
  ArtifactScope,
  isArtifactUri,
  parseArtifactUri,
  ParsedArtifactUri,
  validateArtifactReferenceScope,
  validatePathSegment,
} from './artifact_util.js';
import {
  ArtifactVersion,
  BaseArtifactService,
  DeleteArtifactRequest,
  ListArtifactKeysRequest,
  ListVersionsRequest,
  LoadArtifactRequest,
  SaveArtifactRequest,
} from './base_artifact_service.js';

const GCS_FILE_URI_METADATA_KEY = 'adkFileUri';
const GCS_FILE_MIME_TYPE_METADATA_KEY = 'adkFileMimeType';
const GCS_DISPLAY_NAME_METADATA_KEY = 'adkDisplayName';
const GCS_IS_TEXT_METADATA_KEY = 'adkIsText';

/** The key artifacts written before `adkFileUri` existed still use. */
const LEGACY_FILE_URI_METADATA_KEY = 'file_uri';

/** How many `artifact://` references one read may follow. */
const MAX_ARTIFACT_REFERENCE_DEPTH = 5;

/** How long a signed URL lasts when the caller does not say. */
const SIGNED_URL_TTL_MS = 60 * 60 * 1000;

const AUTHENTICATED_URL_ORIGIN = 'https://storage.cloud.google.com';

const USER_NAMESPACE_PREFIX = 'user:';

const VERSION_LEAF_RE = /^[0-9]+$/;

/** The status the storage client reports for an object that does not exist. */
const OBJECT_NOT_FOUND_CODE = 404;

/** The parameters for {@link GcsArtifactService.getAuthenticatedUrl}. */
export interface GetAuthenticatedUrlRequest extends ArtifactScope {
  /** The filename of the artifact. */
  filename: string;
  /** Defaults to the latest version. */
  version?: number;
}

/** The parameters for {@link GcsArtifactService.getSignedUrl}. */
export interface GetSignedUrlRequest extends GetAuthenticatedUrlRequest {
  /**
   * Options passed to the storage client, merged over the defaults: a `'read'`
   * action and an expiry one hour out.
   */
  signingOptions?: Partial<GetSignedUrlConfig>;
}

/** An object reached after following every `artifact://` reference. */
interface ResolvedArtifactObject {
  objectName: string;
  metadata: FileMetadata;
  /** The pointer the object stores, when it holds a pointer instead of bytes. */
  fileUri?: string;
}

export class GcsArtifactService implements BaseArtifactService {
  private readonly bucketName: string;
  private readonly storageOptions?: StorageOptions;
  private bucketPromise?: Promise<Bucket>;

  constructor(bucket: string, options?: StorageOptions) {
    this.bucketName = bucket;
    this.storageOptions = options;
  }

  /**
   * Resolves the GCS bucket handle, loading the `@google-cloud/storage`
   * optional peer on first use.
   */
  private getBucket(): Promise<Bucket> {
    this.bucketPromise ??= loadOptionalPeer(
      {packageName: '@google-cloud/storage', feature: 'GcsArtifactService'},
      () => import('@google-cloud/storage'),
    ).then(({Storage}) =>
      new Storage(this.storageOptions).bucket(this.bucketName),
    );
    return this.bucketPromise;
  }

  async saveArtifact(request: SaveArtifactRequest): Promise<number> {
    if (
      !request.artifact.inlineData &&
      !request.artifact.text &&
      !request.artifact.fileData
    ) {
      throw new Error('Artifact must have either inlineData or text content.');
    }

    const versions = await this.listVersions(request);
    const version = versions.length > 0 ? Math.max(...versions) + 1 : 0;
    const bucket = await this.getBucket();
    const file = bucket.file(`${getObjectPrefix(request)}/${version}`);

    const customMetadata: Record<string, unknown> = {
      ...request.customMetadata,
    };

    if (request.artifact.inlineData) {
      if (request.artifact.inlineData.displayName) {
        customMetadata[GCS_DISPLAY_NAME_METADATA_KEY] =
          request.artifact.inlineData.displayName;
      }
      await file.save(
        Buffer.from(request.artifact.inlineData.data || '', 'base64'),
        {
          contentType: request.artifact.inlineData.mimeType,
          metadata: {metadata: customMetadata},
        },
      );

      return version;
    } else if (request.artifact.text !== undefined) {
      await file.save(request.artifact.text, {
        contentType: 'text/plain',
        metadata: {
          metadata: {...customMetadata, [GCS_IS_TEXT_METADATA_KEY]: 'true'},
        },
      });

      return version;
    } else {
      const fileData = request.artifact.fileData;
      const fileUri = fileData?.fileUri;
      if (!fileUri) {
        throw new InputValidationError(
          'Artifact fileData must have a fileUri.',
        );
      }
      if (isArtifactUri(fileUri)) {
        referenceTarget(request, fileUri);
      }
      // Store the URI and mime_type (if any) as blob metadata; no content to upload.
      customMetadata[GCS_FILE_URI_METADATA_KEY] = fileUri;
      if (fileData.mimeType) {
        customMetadata[GCS_FILE_MIME_TYPE_METADATA_KEY] = fileData.mimeType;
      }
      await file.save('', {
        contentType: fileData.mimeType || undefined,
        metadata: {metadata: customMetadata},
      });
      return version;
    }
  }

  async loadArtifact(request: LoadArtifactRequest): Promise<Part | undefined> {
    try {
      const resolved = await this.resolveObject(request);
      if (!resolved) {
        return undefined;
      }

      const {objectName, metadata, fileUri} = resolved;
      const customMeta = (metadata.metadata ?? {}) as Record<string, unknown>;

      if (fileUri !== undefined) {
        const mimeType =
          (customMeta[GCS_FILE_MIME_TYPE_METADATA_KEY] as string | undefined) ??
          metadata.contentType ??
          undefined;
        return {fileData: {fileUri, mimeType}};
      }

      const bucket = await this.getBucket();
      const [rawDataBuffer] = await bucket.file(objectName).download();

      const displayName = customMeta[GCS_DISPLAY_NAME_METADATA_KEY] as
        | string
        | undefined;
      if (displayName) {
        return {
          inlineData: {
            data: rawDataBuffer.toString('base64'),
            mimeType: metadata.contentType,
            displayName,
          },
        };
      }

      if (
        customMeta[GCS_IS_TEXT_METADATA_KEY] === 'true' ||
        metadata.contentType === 'text/plain'
      ) {
        return createPartFromText(rawDataBuffer.toString('utf-8'));
      }

      return createPartFromBase64(
        rawDataBuffer.toString('base64'),
        metadata.contentType!,
      );
    } catch (e) {
      if (e instanceof InputValidationError) {
        throw e;
      }
      logger.warn(
        `[GcsArtifactService] loadArtifact: Failed to load artifact ${request.filename}`,
        e,
      );
      return undefined;
    }
  }

  async listArtifactKeys(request: ListArtifactKeysRequest): Promise<string[]> {
    validatePathSegment(request.appName, 'appName');
    validatePathSegment(request.userId, 'userId');
    if (request.sessionId !== undefined) {
      validatePathSegment(request.sessionId, 'sessionId');
    }

    const sessionPrefix = `${request.appName}/${request.userId}/${request.sessionId}/`;
    const usernamePrefix = `${request.appName}/${request.userId}/user/`;
    const bucket = await this.getBucket();
    const [[sessionFiles], [userSessionFiles]] = await Promise.all([
      bucket.getFiles({prefix: sessionPrefix}),
      bucket.getFiles({prefix: usernamePrefix}),
    ]);

    return [
      ...extractArtifactKeys(sessionFiles, sessionPrefix),
      ...extractArtifactKeys(userSessionFiles, usernamePrefix, 'user:'),
    ].sort((a, b) => a.localeCompare(b));
  }

  async deleteArtifact(request: DeleteArtifactRequest): Promise<void> {
    const versions = await this.listVersions(request);
    const bucket = await this.getBucket();

    await Promise.all(
      versions.map((version) =>
        bucket.file(`${getObjectPrefix(request)}/${version}`).delete(),
      ),
    );

    return;
  }

  async listVersions(request: ListVersionsRequest): Promise<number[]> {
    return listObjectVersions(await this.getBucket(), request);
  }

  async listArtifactVersions(
    request: ListVersionsRequest,
  ): Promise<ArtifactVersion[]> {
    const versions = await this.listVersions(request);
    const artifactVersions: ArtifactVersion[] = [];

    for (const version of versions) {
      const artifactVersion = await this.getArtifactVersion({
        ...request,
        version,
      });

      if (artifactVersion) {
        artifactVersions.push(artifactVersion);
      }
    }

    return artifactVersions;
  }

  async getArtifactVersion(
    request: LoadArtifactRequest,
  ): Promise<ArtifactVersion | undefined> {
    try {
      const version = await this.resolveVersion(request);
      if (version === undefined) {
        return undefined;
      }

      const objectName = `${getObjectPrefix(request)}/${version}`;
      const bucket = await this.getBucket();
      const metadata = await readMetadata(bucket.file(objectName));
      if (!metadata) {
        return undefined;
      }

      return {
        version,
        mimeType: metadata.contentType,
        customMetadata: metadata.metadata as Record<string, unknown>,
        canonicalUri: `gs://${this.bucketName}/${objectName}`,
        createTime: parseCreateTime(metadata.timeCreated),
      };
    } catch (e) {
      if (e instanceof InputValidationError) {
        throw e;
      }
      logger.warn(
        `[GcsArtifactService] getArtifactVersion: Failed to get artifact version for userId: ${request.userId} sessionId: ${request.sessionId} filename: ${request.filename} version: ${request.version}`,
        e,
      );
      return undefined;
    }
  }

  /**
   * Builds a browser URL for an artifact.
   *
   * The URL only opens for a user whose Google Account may read the object.
   * An artifact that references another artifact resolves to the target's URL.
   *
   * @param request The artifact to build a URL for.
   * @return The URL, or undefined when the artifact does not exist or stores a
   *     pointer to something outside this service.
   * @throws InputValidationError When an identifier is unsafe, the session is
   *     missing, or a reference leaves the caller's scope.
   */
  async getAuthenticatedUrl(
    request: GetAuthenticatedUrlRequest,
  ): Promise<string | undefined> {
    const resolved = await this.resolveObject(request);
    if (!resolved || resolved.fileUri !== undefined) {
      return undefined;
    }

    const encodedObjectName = resolved.objectName
      .split('/')
      .map(encodeURIComponent)
      .join('/');
    return `${AUTHENTICATED_URL_ORIGIN}/${this.bucketName}/${encodedObjectName}`;
  }

  /**
   * Builds a time-limited signed URL for an artifact.
   *
   * The URL opens without credentials until it expires. An artifact that
   * references another artifact resolves to the target's URL.
   *
   * @param request The artifact to build a URL for, and the signing options.
   * @return The URL, or undefined when the artifact does not exist or stores a
   *     pointer to something outside this service.
   * @throws InputValidationError When an identifier is unsafe, the session is
   *     missing, or a reference leaves the caller's scope.
   */
  async getSignedUrl(
    request: GetSignedUrlRequest,
  ): Promise<string | undefined> {
    const resolved = await this.resolveObject(request);
    if (!resolved || resolved.fileUri !== undefined) {
      return undefined;
    }

    const bucket = await this.getBucket();
    const [url] = await bucket.file(resolved.objectName).getSignedUrl({
      action: 'read',
      expires: Date.now() + SIGNED_URL_TTL_MS,
      ...request.signingOptions,
    });
    return url;
  }

  /**
   * Reads the object an artifact resolves to, following `artifact://`
   * references until one holds content.
   *
   * @param coords The artifact to read.
   * @param depth How many further references the read may follow.
   * @return The object, or undefined when it does not exist.
   * @throws InputValidationError When a reference is malformed, leaves the
   *     caller's scope, or the chain is longer than the depth allows.
   */
  private async resolveObject(
    coords: GetAuthenticatedUrlRequest,
    depth = MAX_ARTIFACT_REFERENCE_DEPTH,
  ): Promise<ResolvedArtifactObject | undefined> {
    const version = await this.resolveVersion(coords);
    if (version === undefined) {
      return undefined;
    }

    const objectName = `${getObjectPrefix(coords)}/${version}`;
    const bucket = await this.getBucket();
    const metadata = await readMetadata(bucket.file(objectName));
    if (!metadata) {
      return undefined;
    }

    const fileUri = getStoredFileUri(metadata);
    if (fileUri === undefined || !isArtifactUri(fileUri)) {
      return {objectName, metadata, fileUri};
    }
    if (depth <= 0) {
      throw new InputValidationError(
        `Exceeded maximum recursion depth resolving artifact reference: ${fileUri}`,
      );
    }
    return this.resolveObject(referenceTarget(coords, fileUri), depth - 1);
  }

  /**
   * Resolves the version an operation addresses, defaulting to the latest.
   *
   * @param coords The artifact to resolve a version for.
   * @return The version, or undefined when the artifact has none.
   */
  private async resolveVersion(
    coords: GetAuthenticatedUrlRequest,
  ): Promise<number | undefined> {
    if (coords.version !== undefined) {
      return coords.version;
    }
    const versions = await listObjectVersions(await this.getBucket(), coords);
    return versions.length > 0 ? Math.max(...versions) : undefined;
  }
}

/**
 * Parses the reference a stored artifact holds, and rejects one the caller may
 * not follow.
 *
 * @param scope The scope the caller operates in.
 * @param fileUri The `artifact://` URI the artifact carries.
 * @return The parsed reference.
 * @throws InputValidationError When the URI is malformed or out of scope.
 */
function referenceTarget(
  scope: ArtifactScope,
  fileUri: string,
): ParsedArtifactUri {
  const parsedUri = parseArtifactUri(fileUri);
  if (!parsedUri) {
    throw new InputValidationError(
      `Invalid artifact reference URI: ${fileUri}`,
    );
  }
  validateArtifactReferenceScope(scope, parsedUri);
  return parsedUri;
}

/**
 * Reads an object's metadata.
 *
 * @param file The object to read.
 * @return The metadata, or undefined when the object does not exist.
 * @throws The storage client's error when the read fails for any other
 *     reason, so that a permission failure does not read as an absent
 *     artifact.
 */
async function readMetadata(file: File): Promise<FileMetadata | undefined> {
  try {
    const [metadata] = await file.getMetadata();
    return metadata;
  } catch (e) {
    if (isObjectNotFound(e)) {
      return undefined;
    }
    throw e;
  }
}

/**
 * Reports whether a storage error means the object does not exist.
 *
 * @param e The error the storage client rejected with.
 * @return True when the error carries the not-found status.
 */
function isObjectNotFound(e: unknown): boolean {
  return e instanceof Error && 'code' in e && e.code === OBJECT_NOT_FOUND_CODE;
}

/**
 * Reads the pointer an object stores, honouring the legacy metadata key.
 *
 * @param metadata The object's metadata.
 * @return The stored URI, or undefined when the object holds content.
 */
function getStoredFileUri(metadata: FileMetadata): string | undefined {
  const customMeta = metadata.metadata ?? {};
  const fileUri =
    customMeta[GCS_FILE_URI_METADATA_KEY] ??
    customMeta[LEGACY_FILE_URI_METADATA_KEY];
  return typeof fileUri === 'string' ? fileUri : undefined;
}

/**
 * Converts the RFC 3339 creation time GCS reports into Unix seconds.
 *
 * @param timeCreated The timestamp GCS reported, if any.
 * @return The timestamp in seconds, or undefined when it is absent or
 *     unparseable.
 */
function parseCreateTime(timeCreated?: string): number | undefined {
  if (!timeCreated) {
    return undefined;
  }
  const milliseconds = Date.parse(timeCreated);
  return Number.isNaN(milliseconds) ? undefined : milliseconds / 1000;
}

/**
 * Lists the versions of one artifact.
 *
 * @param bucket The bucket holding the artifact.
 * @param coords The artifact to list versions of.
 * @return The versions, ascending.
 */
async function listObjectVersions(
  bucket: Bucket,
  coords: GetAuthenticatedUrlRequest,
): Promise<number[]> {
  // The trailing slash keeps the listing to children of this artifact.
  const searchPrefix = `${getObjectPrefix(coords)}/`;
  const [files] = await bucket.getFiles({prefix: searchPrefix});
  const versions: number[] = [];
  for (const file of files) {
    const version = parseVersion(file.name, searchPrefix);
    if (version !== undefined) {
      versions.push(version);
    }
  }

  return versions.sort((a, b) => a - b);
}

/**
 * Extracts the version an object holds.
 *
 * GCS has a flat namespace, so the prefix of an artifact is also the prefix of
 * every artifact nested under it: listing `doc/` to find versions of `doc`
 * also returns `doc/nested/3`, which is version 3 of the distinct artifact
 * `doc/nested`.
 *
 * @param objectName The full name of the object, which starts with the prefix.
 * @param prefix The artifact's object prefix, including the trailing slash.
 * @return The version, or undefined when the object belongs to another
 *     artifact or does not end in a version number.
 */
function parseVersion(objectName: string, prefix: string): number | undefined {
  const suffix = objectName.slice(prefix.length);
  if (suffix.includes('/')) {
    return undefined;
  }
  if (!VERSION_LEAF_RE.test(suffix)) {
    logger.debug(
      `[GcsArtifactService] Skipping ${objectName} because it does not end with a version number.`,
    );
    return undefined;
  }
  return Number.parseInt(suffix, 10);
}

/**
 * Builds the object prefix every version of one artifact sits under.
 *
 * @param coords The artifact.
 * @return The object prefix, without a trailing slash.
 * @throws InputValidationError When an identifier is unsafe, or a
 *     session-scoped artifact has no session.
 */
function getObjectPrefix({
  appName,
  userId,
  sessionId,
  filename,
}: GetAuthenticatedUrlRequest): string {
  validatePathSegment(appName, 'appName');
  validatePathSegment(userId, 'userId');

  if (filename.startsWith(USER_NAMESPACE_PREFIX)) {
    const cleanFilename = filename.substring(USER_NAMESPACE_PREFIX.length);
    return `${appName}/${userId}/user/${cleanFilename}`;
  }

  if (sessionId === undefined) {
    throw new InputValidationError(
      'Session ID must be provided for session-scoped artifacts.',
    );
  }
  validatePathSegment(sessionId, 'sessionId');
  return `${appName}/${userId}/${sessionId}/${filename}`;
}

function extractArtifactKeys(
  files: File[],
  fileNamePrefix: string,
  keyPrefix: string = '',
): string[] {
  const keys = new Set<string>();
  for (const file of files) {
    if (!file.name.startsWith(fileNamePrefix)) {
      continue;
    }

    const relative = file.name.substring(fileNamePrefix.length);
    const name = getFileNameFromPath(relative);

    keys.add(`${keyPrefix}${name}`);
  }

  return [...keys];
}

function getFileNameFromPath(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length < 2) {
    return filePath;
  }

  return parts.slice(0, -1).join('/');
}
