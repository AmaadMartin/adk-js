/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';
import {randomUUID} from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {InputValidationError} from '../errors/input_validation_error.js';
import {isInsideDir} from '../utils/file_utils.js';
import {logger} from '../utils/logger.js';

import {
  ArtifactVersion,
  BaseArtifactService,
  DeleteArtifactRequest,
  ListArtifactKeysRequest,
  ListVersionsRequest,
  LoadArtifactRequest,
  SaveArtifactRequest,
} from './base_artifact_service.js';

const USER_NAMESPACE_PREFIX = 'user:';

/** Directory that holds every stored version of one artifact. */
const VERSIONS_DIRNAME = 'versions';

/**
 * Name of the per-version metadata document. A payload is stored alongside it
 * under the artifact directory's own name, so an artifact whose directory is
 * named `metadata.json` would have its payload written over the metadata
 * document. Callers may not use the name for that reason.
 */
const METADATA_FILENAME = 'metadata.json';

const SAFE_SEGMENT_RE = /^[a-zA-Z0-9_@-][a-zA-Z0-9_.@-]{0,255}$/;

/** Matches a leading Windows drive letter such as `C:`. */
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

/** Matches a directory name that is entirely digits, i.e. a published version. */
const VERSION_DIRNAME_RE = /^\d+$/;

/**
 * Metadata for a file artifact version, as persisted in `metadata.json`.
 */
interface FileArtifactVersion extends ArtifactVersion {
  /** Original filename supplied by the caller. */
  fileName?: string;
  /** Pointer target for a `fileData` artifact, which stores no payload. */
  fileUri?: string;
  /** User-facing filename taken from `inlineData.displayName` when persisted. */
  displayName?: string;
}

/** The payload description produced by staging an artifact's content. */
interface StagedContent {
  mimeType?: string;
  fileUri?: string;
  displayName?: string;
}

/** A reserved version number together with its staging and final directories. */
export interface VersionReservation {
  version: number;
  stagingDir: string;
  versionDir: string;
}

/**
 * Service for managing artifacts stored on the local filesystem.
 *
 * Stores filesystem-backed artifacts beneath a configurable root directory.
 *
 * Storage layout matches the cloud and in-memory services:
 * root/
 * └── apps/
 *     └── {appName}/
 *         └── users/
 *             └── {userId}/
 *                 ├── sessions/
 *                 │   └── {sessionId}/
 *                 │       └── artifacts/
 *                 │           └── {artifactPath}/  // derived from filename
 *                 │               └── versions/
 *                 │                   ├── .{version}.pending/  // in progress
 *                 │                   └── {version}/
 *                 │                       ├── {originalFilename}
 *                 │                       └── metadata.json
 *                 └── artifacts/
 *                     └── {artifactPath}/...
 *
 * Releases that predate the `apps/{appName}` level wrote the same tree directly
 * under `root/users`, which records no app name. A root can be shared by
 * several apps, so that tree cannot be attributed to one of them and is never
 * read from, written to, or deleted.
 *
 * Artifact paths are derived from the provided filenames: separators create
 * nested directories, and path traversal is rejected to keep the layout
 * portable across filesystems. `{artifactPath}` therefore mirrors the
 * sanitized, scope-relative path derived from each filename. That rejection is
 * a lexical check on the supplied string, not a sandbox: it does not survive
 * symlinks, hardlinks, bind mounts, or a directory swapped between the check
 * and the write.
 *
 * A save stages into `.{version}.pending` and publishes it with a single
 * rename, so readers only ever observe complete versions. A staging directory
 * left behind by a killed save is never read, but it keeps its version number
 * reserved, so published versions are not guaranteed to be contiguous.
 */
export class FileArtifactService implements BaseArtifactService {
  private readonly rootDir: string;

  constructor(rootDirOrUri: string) {
    try {
      const rootDir = rootDirOrUri.startsWith('file://')
        ? fileURLToPath(rootDirOrUri)
        : rootDirOrUri;
      this.rootDir = path.resolve(rootDir);
    } catch (e: unknown) {
      throw new Error(`Invalid root directory: ${rootDirOrUri}`, {cause: e});
    }
  }

  /**
   * Validates every identifier and resolves the artifact's own directory plus
   * the scope root that contains it.
   */
  private resolveArtifact(
    appName: string,
    userId: string,
    sessionId: string,
    filename: string,
  ): {artifactDir: string; scopeRoot: string} {
    const baseRoot = getUserRoot(getAppRoot(this.rootDir, appName), userId);
    const scopeRoot = getScopeRoot(baseRoot, sessionId, filename);
    return {
      artifactDir: resolveScopedArtifactPath(scopeRoot, filename),
      scopeRoot,
    };
  }

  async saveArtifact({
    appName,
    userId,
    sessionId,
    filename,
    artifact,
    customMetadata,
  }: SaveArtifactRequest): Promise<number> {
    const {artifactDir} = this.resolveArtifact(
      appName,
      userId,
      sessionId,
      filename,
    );
    // Enforced here rather than in the shared path resolution, which reads and
    // deletes share: an artifact stored under this name before the name was
    // rejected must stay readable and, above all, deletable.
    if (isReservedArtifactName(path.basename(artifactDir))) {
      throw new InputValidationError(
        `[FileArtifactService] Artifact filename ${filename} is reserved: an ` +
          `artifact may not be named ${METADATA_FILENAME} (in any casing) ` +
          `because its payload is stored under the artifact's own name and ` +
          `would overwrite the metadata document.`,
      );
    }

    const versionsDir = getVersionsDir(artifactDir);
    await fs.mkdir(versionsDir, {recursive: true});
    const published = await listVersionsOnDisk(artifactDir);
    const {version, stagingDir, versionDir} = await reserveVersionDir(
      versionsDir,
      published.length > 0 ? published[published.length - 1] + 1 : 0,
    );

    // A version directory is only ever observed complete or not at all. A
    // partially written version -- payload present, metadata missing or
    // truncated -- is indistinguishable from a valid one on the read path, so
    // any failure discards the whole staging directory instead of publishing.
    try {
      const storedFilename = path.basename(artifactDir);
      const content = await writeArtifactPayload(
        path.join(stagingDir, storedFilename),
        artifact,
      );
      await writeMetadata(path.join(stagingDir, METADATA_FILENAME), {
        fileName: filename,
        mimeType: content.mimeType,
        fileUri: content.fileUri,
        displayName: content.displayName,
        version,
        canonicalUri: getCanonicalUri(artifactDir, version),
        customMetadata: customMetadata ?? {},
      });
      await fs.rename(stagingDir, versionDir);
    } catch (e: unknown) {
      // Reported rather than raised, so a cleanup failure cannot replace the
      // error that caused it.
      await removeQuietly(stagingDir);
      throw e;
    }

    logger.debug(
      `[FileArtifactService] Saved artifact ${filename} version ${version} to ${versionDir}`,
    );
    return version;
  }

  async loadArtifact({
    appName,
    userId,
    sessionId,
    filename,
    version,
  }: LoadArtifactRequest): Promise<Part | undefined> {
    const {artifactDir} = this.resolveArtifact(
      appName,
      userId,
      sessionId,
      filename,
    );
    const versionToLoad = await resolveVersion(artifactDir, version);
    if (versionToLoad === undefined) {
      return undefined;
    }

    const metadata = await readMetadata(
      getMetadataPath(artifactDir, versionToLoad),
    );
    if (metadata?.fileUri) {
      return {
        fileData: {fileUri: metadata.fileUri, mimeType: metadata.mimeType},
      };
    }

    // The payload location is derived exclusively from the storage layout. It
    // is never taken from the metadata document: that document lives in the
    // artifact tree and is therefore attacker-influenced input, so honouring a
    // `canonicalUri` from it would turn this into an arbitrary file read. The
    // read runs without a preceding existence check, because reacting to the
    // gap between the check and the read is what reached that path before.
    const contentPath = getPayloadPath(artifactDir, versionToLoad);
    const payload = await readPayloadIfPresent(contentPath);
    if (payload === undefined) {
      logger.warn(
        `[FileArtifactService] loadArtifact: Artifact ${filename} missing at ${contentPath}`,
      );
      return undefined;
    }

    if (metadata?.mimeType) {
      return {
        inlineData: {
          mimeType: metadata.mimeType,
          data: payload.toString('base64'),
          displayName: metadata.displayName,
        },
      };
    }
    return {text: payload.toString('utf-8')};
  }

  async listArtifactKeys({
    appName,
    userId,
    sessionId,
  }: ListArtifactKeysRequest): Promise<string[]> {
    const filenames = new Set<string>();
    const baseRoot = getUserRoot(getAppRoot(this.rootDir, appName), userId);

    const sessionRoot = getSessionArtifactsDir(baseRoot, sessionId);
    for await (const artifactDir of iterateArtifactDirs(sessionRoot)) {
      filenames.add(await artifactKey(artifactDir, sessionRoot, ''));
    }

    const artifactsRoot = getUserArtifactsDir(baseRoot);
    for await (const artifactDir of iterateArtifactDirs(artifactsRoot)) {
      filenames.add(
        await artifactKey(artifactDir, artifactsRoot, USER_NAMESPACE_PREFIX),
      );
    }

    return Array.from(filenames).sort();
  }

  async deleteArtifact({
    appName,
    userId,
    sessionId,
    filename,
  }: DeleteArtifactRequest): Promise<void> {
    const {artifactDir, scopeRoot} = this.resolveArtifact(
      appName,
      userId,
      sessionId,
      filename,
    );
    const versionsDir = getVersionsDir(artifactDir);
    if (!(await pathExists(versionsDir))) {
      return;
    }
    // Only this artifact's own versions go. Its directory may also be the
    // parent of a nested artifact ("doc" vs "doc/nested"), so it is pruned
    // separately and only if nothing is left under it.
    await fs.rm(versionsDir, {recursive: true, force: true});
    await pruneEmptyDirs(artifactDir, scopeRoot);
    logger.debug(
      `[FileArtifactService] Deleted artifact ${filename} at ${artifactDir}`,
    );
  }

  async listVersions({
    appName,
    userId,
    sessionId,
    filename,
  }: ListVersionsRequest): Promise<number[]> {
    const {artifactDir} = this.resolveArtifact(
      appName,
      userId,
      sessionId,
      filename,
    );
    return listVersionsOnDisk(artifactDir);
  }

  async listArtifactVersions({
    appName,
    userId,
    sessionId,
    filename,
  }: ListVersionsRequest): Promise<ArtifactVersion[]> {
    const {artifactDir} = this.resolveArtifact(
      appName,
      userId,
      sessionId,
      filename,
    );
    const versions = await listVersionsOnDisk(artifactDir);
    return Promise.all(
      versions.map(async (version) =>
        buildArtifactVersion(
          artifactDir,
          version,
          await readMetadata(getMetadataPath(artifactDir, version)),
        ),
      ),
    );
  }

  async getArtifactVersion({
    appName,
    userId,
    sessionId,
    filename,
    version,
  }: LoadArtifactRequest): Promise<ArtifactVersion | undefined> {
    const {artifactDir} = this.resolveArtifact(
      appName,
      userId,
      sessionId,
      filename,
    );
    const versionToRead = await resolveVersion(artifactDir, version);
    if (versionToRead === undefined) {
      return undefined;
    }
    return buildArtifactVersion(
      artifactDir,
      versionToRead,
      await readMetadata(getMetadataPath(artifactDir, versionToRead)),
    );
  }
}

export function assertSafeSegment(value: string, label: string): void {
  if (!value || !SAFE_SEGMENT_RE.test(value)) {
    throw new InputValidationError(
      `[FileArtifactService] Invalid ${label}: value contains disallowed characters.`,
    );
  }
}

export function assertInsideRoot(
  resolvedPath: string,
  rootDir: string,
  label: string,
): void {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(resolvedPath);
  if (!isInsideDir(resolved, root)) {
    throw new InputValidationError(
      `[FileArtifactService] ${label} escapes storage root. Resolved: ${resolved}, Root: ${root}`,
    );
  }
}

/**
 * Returns the app-scoped root that contains every user's artifacts for one
 * application.
 */
export function getAppRoot(rootDir: string, appName: string): string {
  assertSafeSegment(appName, 'appName');
  const result = path.join(rootDir, 'apps', appName);
  assertInsideRoot(result, rootDir, 'appRoot');
  return result;
}

export function getUserRoot(baseRoot: string, userId: string): string {
  assertSafeSegment(userId, 'userId');
  const result = path.join(baseRoot, 'users', userId);
  assertInsideRoot(result, baseRoot, 'userRoot');
  return result;
}

export function getSessionArtifactsDir(
  baseRoot: string,
  sessionId: string,
): string {
  assertSafeSegment(sessionId, 'sessionId');
  const result = path.join(baseRoot, 'sessions', sessionId, 'artifacts');
  assertInsideRoot(result, baseRoot, 'sessionArtifactsDir');
  return result;
}

function getUserArtifactsDir(baseRoot: string): string {
  return path.join(baseRoot, 'artifacts');
}

function getVersionsDir(artifactDir: string): string {
  return path.join(artifactDir, VERSIONS_DIRNAME);
}

function getMetadataPath(artifactDir: string, version: number): string {
  return path.join(
    getVersionsDir(artifactDir),
    String(version),
    METADATA_FILENAME,
  );
}

function getPayloadPath(artifactDir: string, version: number): string {
  return path.join(
    getVersionsDir(artifactDir),
    String(version),
    path.basename(artifactDir),
  );
}

/** Builds the canonical `file://` URI for an artifact payload. */
function getCanonicalUri(artifactDir: string, version: number): string {
  return pathToFileURL(getPayloadPath(artifactDir, version)).toString();
}

/**
 * Returns the directory that represents the artifact scope.
 *
 * Only the `user:` prefix selects the user namespace. A missing or empty
 * `sessionId` is a caller mistake and is reported as one, because silently
 * widening the scope would publish a session artifact to every session of
 * that user.
 */
function getScopeRoot(
  baseRoot: string,
  sessionId: string,
  filename: string,
): string {
  return filename.startsWith(USER_NAMESPACE_PREFIX)
    ? getUserArtifactsDir(baseRoot)
    : getSessionArtifactsDir(baseRoot, sessionId);
}

/**
 * Checks whether an artifact directory name collides with the metadata
 * document.
 *
 * Compared caselessly because the collision is decided by the filesystem, and
 * the case-insensitive ones ADK supports (APFS, NTFS) resolve `Metadata.json`
 * and `metadata.json` to the same file.
 */
function isReservedArtifactName(name: string): boolean {
  return name.toLowerCase() === METADATA_FILENAME.toLowerCase();
}

/** Normalizes Windows separators so both platforms produce the same tree. */
function toPosixPath(value: string): string {
  return value.split('\\').join('/');
}

/** Checks POSIX and Windows rooted or drive-qualified path forms. */
function isRootedOrDriveQualified(value: string): boolean {
  // A leading separator covers POSIX absolute paths, UNC and device prefixes
  // alike; only the drive-relative form (`C:name`) has no root of its own.
  return (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    WINDOWS_DRIVE_RE.test(value)
  );
}

/** Checks parent traversal using either platform's separators. */
function hasParentReference(value: string): boolean {
  return toPosixPath(value).split('/').includes('..');
}

/**
 * Resolves a caller-supplied filename to its artifact directory under the
 * scope root.
 *
 * Filenames that are rooted, drive-qualified, or contain a parent reference are
 * rejected outright, including parent references that would resolve back inside
 * the scope root.
 *
 * @param scopeRoot Directory that defines the storage scope.
 * @param filename Caller-supplied artifact name.
 * @returns The absolute artifact directory.
 */
function resolveScopedArtifactPath(
  scopeRoot: string,
  filename: string,
): string {
  const stripped = filename.startsWith(USER_NAMESPACE_PREFIX)
    ? filename.substring(USER_NAMESPACE_PREFIX.length).trim()
    : filename.trim();

  if (isRootedOrDriveQualified(stripped)) {
    throw new InputValidationError(
      `[FileArtifactService] Rooted or drive-qualified artifact filename ${filename} is not permitted; provide a path relative to the storage scope.`,
    );
  }
  if (hasParentReference(stripped)) {
    throw new InputValidationError(
      `[FileArtifactService] Artifact filename ${filename} must not contain parent traversal.`,
    );
  }

  const resolvedScopeRoot = path.resolve(scopeRoot);
  const artifactDir = path.resolve(resolvedScopeRoot, toPosixPath(stripped));
  // Defence in depth. The rejections above already exclude every filename that
  // could resolve outside the scope, so this only fires if one of them is
  // weakened. `assertInsideRoot` carries the same containment rule the storage
  // helpers use, and its own tests pin the throw.
  assertInsideRoot(artifactDir, resolvedScopeRoot, `filename ${filename}`);
  if (artifactDir === resolvedScopeRoot) {
    return path.join(resolvedScopeRoot, 'artifact');
  }
  return artifactDir;
}

/**
 * Removes a file or directory tree on a failure path.
 *
 * A cleanup failure is logged rather than raised, so it cannot replace the
 * error that led here.
 */
async function removeQuietly(target: string): Promise<void> {
  try {
    await fs.rm(target, {recursive: true, force: true});
  } catch (e: unknown) {
    logger.warn(`[FileArtifactService] Failed to remove ${target}`, e);
  }
}

/** Reports whether a filesystem entry exists at `target`. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Reports whether a thrown value is a Node system error carrying `code`. */
function hasErrorCode(e: unknown, code: string): boolean {
  return e instanceof Error && 'code' in e && e.code === code;
}

/**
 * Reserves the first free version at or after `startVersion`.
 *
 * The staging directory is created without `recursive`, so a second saver
 * racing for the same number observes `EEXIST` and moves on. A version already
 * published is skipped too, which is what keeps a saver that read a stale
 * version list from republishing over it.
 *
 * @param versionsDir Directory that holds this artifact's versions.
 * @param startVersion First version number to attempt.
 * @returns The reserved version with its staging and final directories.
 */
export async function reserveVersionDir(
  versionsDir: string,
  startVersion: number,
): Promise<VersionReservation> {
  let version = startVersion;
  for (;;) {
    const stagingDir = path.join(versionsDir, `.${version}.pending`);
    try {
      await fs.mkdir(stagingDir);
    } catch (e: unknown) {
      if (!hasErrorCode(e, 'EEXIST')) {
        throw e;
      }
      version += 1;
      continue;
    }

    const versionDir = path.join(versionsDir, String(version));
    if (!(await pathExists(versionDir))) {
      return {version, stagingDir, versionDir};
    }
    await fs.rmdir(stagingDir);
    version += 1;
  }
}

/**
 * Writes an artifact's payload into its staging directory.
 *
 * A `fileData` artifact is a pointer and stores no payload, so only its target
 * is recorded.
 *
 * @param contentPath Where the payload belongs inside the staging directory.
 * @param artifact The part supplied by the caller.
 * @returns The MIME type, pointer target and display name to persist.
 */
async function writeArtifactPayload(
  contentPath: string,
  artifact: Part,
): Promise<StagedContent> {
  if (artifact.inlineData) {
    const {data, mimeType, displayName} = artifact.inlineData;
    if (data === undefined) {
      throw new InputValidationError(
        '[FileArtifactService] Artifact inlineData must contain data.',
      );
    }
    // GenAI SDK Part data is in Base64 format. See https://googleapis.github.io/js-genai/release_docs/interfaces/types.Part.html
    await fs.writeFile(contentPath, Buffer.from(data, 'base64'));
    return {mimeType: mimeType || 'application/octet-stream', displayName};
  }

  if (artifact.text !== undefined) {
    await fs.writeFile(contentPath, artifact.text, 'utf-8');
    return {};
  }

  if (!artifact.fileData) {
    throw new InputValidationError(
      '[FileArtifactService] Artifact must have either inlineData or text content.',
    );
  }
  const fileUri = artifact.fileData.fileUri;
  if (!fileUri) {
    throw new InputValidationError(
      '[FileArtifactService] Artifact fileData must have a fileUri.',
    );
  }
  return {mimeType: artifact.fileData.mimeType, fileUri};
}

/**
 * Persists metadata describing an artifact version.
 *
 * @param metadataPath Where the metadata document belongs.
 * @param metadata The document to write.
 */
async function writeMetadata(
  metadataPath: string,
  metadata: FileArtifactVersion,
): Promise<void> {
  // Serialize before touching the filesystem: `customMetadata` is caller
  // supplied and can fail to serialize, and that must not be able to leave a
  // truncated document behind.
  const serialized = JSON.stringify(metadata);

  // Write via a uniquely named temporary file in the same directory and rename
  // it into place, so readers never observe a partial document.
  const tmpPath = path.join(path.dirname(metadataPath), `.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmpPath, serialized, 'utf-8');
    await fs.rename(tmpPath, metadataPath);
  } catch (e: unknown) {
    await removeQuietly(tmpPath);
    throw e;
  }
}

/**
 * Loads a metadata document from disk.
 *
 * The path is derived from a caller-supplied filename, so it can be made to
 * name a directory rather than a file; that degrades to "no metadata" instead
 * of raising.
 *
 * @param metadataPath Location of the metadata document.
 * @returns The parsed metadata, or undefined for anything that is not a
 *     readable, well-formed document.
 */
async function readMetadata(
  metadataPath: string,
): Promise<FileArtifactVersion | undefined> {
  try {
    const content = await fs.readFile(metadataPath, 'utf-8');
    return JSON.parse(content) as FileArtifactVersion;
  } catch (e: unknown) {
    if (!hasErrorCode(e, 'ENOENT')) {
      logger.warn(
        `[FileArtifactService] Unreadable metadata at ${metadataPath}`,
        e,
      );
    }
    return undefined;
  }
}

/**
 * Reads an artifact payload.
 *
 * @param payloadPath Location of the payload.
 * @returns The file contents, or undefined if it is not a readable file.
 */
async function readPayloadIfPresent(
  payloadPath: string,
): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(payloadPath);
  } catch (e: unknown) {
    if (!hasErrorCode(e, 'ENOENT')) {
      logger.warn(
        `[FileArtifactService] Unreadable artifact payload at ${payloadPath}`,
        e,
      );
    }
    return undefined;
  }
}

/** Returns the sorted versions published under an artifact directory. */
async function listVersionsOnDisk(artifactDir: string): Promise<number[]> {
  const versionsDir = getVersionsDir(artifactDir);
  try {
    const entries = await fs.readdir(versionsDir, {withFileTypes: true});
    return entries
      .filter(
        (entry) => entry.isDirectory() && VERSION_DIRNAME_RE.test(entry.name),
      )
      .map((entry) => Number(entry.name))
      .sort((a, b) => a - b);
  } catch (e: unknown) {
    if (!hasErrorCode(e, 'ENOENT')) {
      logger.warn(
        `[FileArtifactService] Failed to list versions in ${versionsDir}`,
        e,
      );
    }
    return [];
  }
}

/**
 * Resolves the version a read should serve.
 *
 * @param artifactDir The artifact directory.
 * @param version The requested version, or undefined for the latest.
 * @returns The version to read, or undefined when it is not stored.
 */
async function resolveVersion(
  artifactDir: string,
  version: number | undefined,
): Promise<number | undefined> {
  const versions = await listVersionsOnDisk(artifactDir);
  if (versions.length === 0) {
    return undefined;
  }
  if (version === undefined) {
    return versions[versions.length - 1];
  }
  return versions.includes(version) ? version : undefined;
}

/** Creates the caller-facing handle for one stored version. */
function buildArtifactVersion(
  artifactDir: string,
  version: number,
  metadata: FileArtifactVersion | undefined,
): ArtifactVersion {
  // The canonical URI is always recomputed from the storage layout rather than
  // read back from the metadata document, so a tampered document cannot
  // dictate the URI handed to callers.
  return {
    version,
    canonicalUri: getCanonicalUri(artifactDir, version),
    customMetadata: {...metadata?.customMetadata},
    mimeType: metadata?.mimeType,
  };
}

/**
 * Returns the key an artifact is listed under: its original filename when the
 * metadata document is readable, and its scope-relative path otherwise.
 */
async function artifactKey(
  artifactDir: string,
  scopeRoot: string,
  prefix: string,
): Promise<string> {
  const versions = await listVersionsOnDisk(artifactDir);
  const metadata =
    versions.length > 0
      ? await readMetadata(
          getMetadataPath(artifactDir, versions[versions.length - 1]),
        )
      : undefined;
  if (metadata?.fileName) {
    return metadata.fileName;
  }
  return `${prefix}${toPosixPath(path.relative(scopeRoot, artifactDir))}`;
}

/**
 * Yields every artifact directory beneath `dir`.
 *
 * @param dir The directory to walk.
 */
export async function* iterateArtifactDirs(
  dir: string,
): AsyncGenerator<string> {
  // An unreadable directory holds no artifacts anyone can list.
  const entries = await fs.readdir(dir, {withFileTypes: true}).catch(() => []);
  if (
    entries.some(
      (entry) => entry.isDirectory() && entry.name === VERSIONS_DIRNAME,
    )
  ) {
    yield dir;
  }
  // An artifact directory doubles as the parent of anything nested under it
  // ("doc" and "doc/nested"), so keep descending, skipping only the stored
  // versions of this artifact.
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== VERSIONS_DIRNAME) {
      yield* iterateArtifactDirs(path.join(dir, entry.name));
    }
  }
}

/**
 * Removes `leaf` and any parents it leaves empty, stopping at `stopAt`.
 *
 * Filenames may contain "/", so the directory of an artifact doubles as the
 * parent directory of every artifact nested under it: "doc" is stored at
 * `{scope}/doc` and "doc/nested" at `{scope}/doc/nested`. A directory may
 * therefore only be removed once it holds nothing.
 *
 * @param leaf Directory to remove, if it is empty.
 * @param stopAt Scope root. It and everything above it are never removed.
 */
async function pruneEmptyDirs(leaf: string, stopAt: string): Promise<void> {
  let current = leaf;
  while (current !== stopAt && isInsideDir(current, stopAt)) {
    try {
      // Only succeeds on an empty directory.
      await fs.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}
