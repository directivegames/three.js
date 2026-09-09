// WITH_GENESYS
/**
 * Keep in sync with genesys-monorepo scripts/publish-version.ts.
 * Copied into this nested repo so the Publish workflow can bump from git tags
 * without depending on the parent monorepo checkout.
 */
/**
 * Resolve a published package version from git tags (or an explicit current
 * version) and bump it. Git-tracked workspace package.json files stay at 0.0.0.
 *
 * @module scripts/publish-version
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BUMP_TYPES = ['major', 'minor', 'patch'] as const;

export type BumpType = (typeof BUMP_TYPES)[number];

export const NPM_DIST_TAGS = ['latest', 'dev', 'staging'] as const;

export type NpmDistTag = (typeof NPM_DIST_TAGS)[number];

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

export function isBumpType(value: string): value is BumpType {
  return (BUMP_TYPES as readonly string[]).includes(value);
}

export function isNpmDistTag(value: string): value is NpmDistTag {
  return (NPM_DIST_TAGS as readonly string[]).includes(value);
}

/**
 * Resolve a package directory or package.json path to a package.json file.
 */
export function resolvePackageJsonPath(input: string): string {
  const resolved = resolve(process.cwd(), input);

  if (resolved.endsWith('package.json')) {
    if (!existsSync(resolved)) {
      throw new Error(`package.json not found: ${resolved}`);
    }
    return resolved;
  }

  const packageJsonPath = join(resolved, 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new Error(`No package.json found at ${input}`);
  }

  return packageJsonPath;
}

const PARTIAL_VERSION_RE = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
const PARTIAL_VERSION_HELP = 'Expected major, major.minor, or major.minor.patch.';

/**
 * Parse `major.minor.patch` with an optional `-prerelease` suffix.
 */
export function parseVersion(version: string): ParsedVersion {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!match) {
    throw new Error(`Invalid version: ${version}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/**
 * Parse a publish target of `major`, `major.minor`, or `major.minor.patch`.
 * Missing minor/patch default to 0. Prerelease suffixes are rejected.
 */
export function parsePartialVersion(version: string): Pick<ParsedVersion, 'major' | 'minor' | 'patch'> {
  const match = version.trim().match(PARTIAL_VERSION_RE);
  if (!match) {
    throw new Error(`Invalid next version: ${version}. ${PARTIAL_VERSION_HELP}`);
  }

  return {
    major: Number(match[1]),
    minor: match[2] !== undefined ? Number(match[2]) : 0,
    patch: match[3] !== undefined ? Number(match[3]) : 0,
  };
}

/**
 * Numeric core of a full semver or a partial next-version input.
 */
export function parseVersionNumbers(version: string): Pick<ParsedVersion, 'major' | 'minor' | 'patch'> {
  try {
    const parsed = parseVersion(version);
    return { major: parsed.major, minor: parsed.minor, patch: parsed.patch };
  } catch {
    return parsePartialVersion(version);
  }
}

/**
 * Expand a partial next version and apply `--preid` from the publish channel.
 */
export function resolveSpecifiedNextVersion(version: string, preid?: string): string {
  const parsed = parsePartialVersion(version);
  return formatVersion(parsed.major, parsed.minor, parsed.patch, preid ?? null);
}

/**
 * Infer major / minor / patch from two versions. Throws when `next` is not greater.
 */
export function inferBumpType(previousVersion: string, nextVersion: string): BumpType {
  const previous = parseVersionNumbers(previousVersion);
  const next = parseVersionNumbers(nextVersion);

  if (next.major !== previous.major) {
    if (next.major < previous.major) {
      throw new Error(`Next version ${nextVersion} is not greater than ${previousVersion}`);
    }
    return 'major';
  }

  if (next.minor !== previous.minor) {
    if (next.minor < previous.minor) {
      throw new Error(`Next version ${nextVersion} is not greater than ${previousVersion}`);
    }
    return 'minor';
  }

  if (next.patch !== previous.patch) {
    if (next.patch < previous.patch) {
      throw new Error(`Next version ${nextVersion} is not greater than ${previousVersion}`);
    }
    return 'patch';
  }

  throw new Error(`Next version ${nextVersion} is not greater than ${previousVersion}`);
}

/**
 * Apply a semver bump to the numeric portion only.
 */
export function bumpNumericVersion(
  major: number,
  minor: number,
  patch: number,
  bumpType: BumpType,
): Pick<ParsedVersion, 'major' | 'minor' | 'patch'> {
  if (bumpType === 'major') {
    return { major: major + 1, minor: 0, patch: 0 };
  }

  if (bumpType === 'minor') {
    return { major, minor: minor + 1, patch: 0 };
  }

  return { major, minor, patch: patch + 1 };
}

/**
 * Format a version string, optionally with a prerelease suffix.
 */
export function formatVersion(
  major: number,
  minor: number,
  patch: number,
  prerelease: string | null,
): string {
  const base = `${major}.${minor}.${patch}`;
  return prerelease ? `${base}-${prerelease}` : base;
}

/**
 * Bump the numeric part of `current` and apply `--preid` when the current
 * version has no prerelease id.
 */
export function computeBumpedVersion(
  current: string,
  bumpType: BumpType,
  preid?: string,
): string {
  const parsed = parseVersion(current);
  const bumped = bumpNumericVersion(parsed.major, parsed.minor, parsed.patch, bumpType);
  const prerelease = parsed.prerelease ?? preid ?? null;
  return formatVersion(bumped.major, bumped.minor, bumped.patch, prerelease);
}

/**
 * Next published version: bump `baseVersion`, or start from `0.0.0` when
 * the git-tag (or dist-tag) base is missing.
 */
export function resolveNextPublishVersion(
  baseVersion: string | undefined,
  bumpType: BumpType,
  preid?: string,
): string {
  const current = baseVersion && baseVersion.length > 0 ? baseVersion : '0.0.0';
  return computeBumpedVersion(current, bumpType, preid);
}

/**
 * Default git tag prefix for a package: `{name}/`.
 */
export function defaultGitTagPrefix(packageName: string): string {
  return `${packageName}/`;
}

/**
 * Strip `refs/tags/` and peeled `^{}` from a `git ls-remote --tags` ref.
 */
export function parseGitLsRemoteTagName(ref: string): string | undefined {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const tabIndex = trimmed.indexOf('\t');
  const raw = tabIndex === -1 ? trimmed : trimmed.slice(tabIndex + 1);
  let name = raw.startsWith('refs/tags/') ? raw.slice('refs/tags/'.length) : raw;
  if (name.endsWith('^{}')) {
    name = name.slice(0, -3);
  }
  return name.length > 0 ? name : undefined;
}

/**
 * Parse `git ls-remote --tags` stdout into tag names (peeled duplicates dropped).
 */
export function parseGitLsRemoteTagNames(stdout: string): string[] {
  const names = new Set<string>();
  for (const line of stdout.split('\n')) {
    const name = parseGitLsRemoteTagName(line);
    if (name) {
      names.add(name);
    }
  }
  return [...names];
}

/**
 * Version suffix after `prefix`, or `undefined` when the tag is not a semver under that prefix.
 */
export function gitTagVersion(tagName: string, prefix: string): string | undefined {
  if (!tagName.startsWith(prefix)) {
    return undefined;
  }

  const rest = tagName.slice(prefix.length);
  try {
    parseVersion(rest);
    return rest;
  } catch {
    return undefined;
  }
}

/**
 * True when `version`'s prerelease id matches the publish channel.
 * Live (`preid` empty) keeps only versions with no prerelease.
 */
export function matchesChannelPreid(version: string, preid?: string): boolean {
  const parsed = parseVersion(version);
  if (!preid) {
    return parsed.prerelease === null;
  }

  const prerelease = parsed.prerelease;
  return prerelease === preid || (prerelease !== null && prerelease.startsWith(`${preid}.`));
}

const NUMERIC_PRERELEASE_IDENT_RE = /^\d+$/;

/**
 * Semver prerelease compare. Numeric idents are numbers; a longer ident list
 * wins when the shared prefix matches; no prerelease ranks above prerelease.
 */
function comparePrerelease(a: string | null, b: string | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }

  const aParts = a.split('.');
  const bParts = b.split('.');
  const length = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < length; i++) {
    const aPart = aParts[i];
    const bPart = bParts[i];
    if (aPart === undefined) {
      return -1;
    }
    if (bPart === undefined) {
      return 1;
    }

    const aNumeric = NUMERIC_PRERELEASE_IDENT_RE.test(aPart);
    const bNumeric = NUMERIC_PRERELEASE_IDENT_RE.test(bPart);
    if (aNumeric && bNumeric) {
      const diff = Number(aPart) - Number(bPart);
      if (diff !== 0) {
        return diff;
      }
      continue;
    }
    if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    }
    if (aPart !== bPart) {
      return aPart < bPart ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Compare two full semver strings. Positive when `a` is greater.
 */
export function compareReleaseVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa.major !== pb.major) {
    return pa.major - pb.major;
  }
  if (pa.minor !== pb.minor) {
    return pa.minor - pb.minor;
  }
  if (pa.patch !== pb.patch) {
    return pa.patch - pb.patch;
  }
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/**
 * Highest semver under `prefix` for this channel preid. Missing → `undefined`.
 */
export function selectHighestGitPrefixVersion(
  tagNames: string[],
  prefix: string,
  preid?: string,
): string | undefined {
  let highest: string | undefined;
  for (const tagName of tagNames) {
    const version = gitTagVersion(tagName, prefix);
    if (!version || !matchesChannelPreid(version, preid)) {
      continue;
    }
    if (!highest || compareReleaseVersions(version, highest) > 0) {
      highest = version;
    }
  }
  return highest;
}

/**
 * Read matching tags from `origin` and return the highest channel version.
 * No matching tags → `undefined`. `git ls-remote` failure throws.
 */
export function fetchGitPrefixVersion(prefix: string, preid?: string): string | undefined {
  let raw: string;
  try {
    raw = execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/${prefix}*`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(gitLsRemoteFailureMessage(prefix, error));
  }
  return selectHighestGitPrefixVersion(parseGitLsRemoteTagNames(raw), prefix, preid);
}

/**
 * Human-readable `git ls-remote` failure, preferring stderr when present.
 */
export function gitLsRemoteFailureMessage(prefix: string, error: unknown): string {
  let detail = error instanceof Error ? error.message : String(error);
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim().length > 0) {
      detail = stderr.trim();
    }
  }
  return `Failed to list git tags for prefix '${prefix}': ${detail}`;
}

export function readPackageName(packageJsonPath: string): string {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: string };
  if (typeof pkg.name !== 'string' || pkg.name.length === 0) {
    throw new Error(`Missing name in ${packageJsonPath}`);
  }
  return pkg.name;
}

export function readPackageVersion(packageJsonPath: string): string {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
  if (typeof pkg.version !== 'string') {
    throw new Error(`Missing version in ${packageJsonPath}`);
  }
  return pkg.version;
}

/**
 * First `bin` key, or empty when the package has no bin.
 */
export function readPackageBinName(packageJsonPath: string): string {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    name?: string;
    bin?: string | Record<string, string>;
  };
  if (typeof pkg.bin === 'string') {
    const name = pkg.name ?? '';
    const slash = name.lastIndexOf('/');
    return slash === -1 ? name : name.slice(slash + 1);
  }
  if (pkg.bin && typeof pkg.bin === 'object') {
    return Object.keys(pkg.bin)[0] ?? '';
  }
  return '';
}

/**
 * Overwrite `version` in package.json for this workspace only (not committed).
 */
export function writePackageVersion(packageJsonPath: string, version: string): void {
  parseVersion(version);
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
  pkg.version = version;
  writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

/**
 * Read `dist-tags` for `packageName`. Missing package or tag → `undefined`.
 */
export function fetchNpmDistTagVersion(packageName: string, tag: NpmDistTag): string | undefined {
  try {
    const raw = execFileSync('npm', ['view', packageName, 'dist-tags', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tags = JSON.parse(raw) as Record<string, unknown>;
    const version = tags[tag];
    return typeof version === 'string' && version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Current dist-tag version, or throw. Used when a consumer (SDK) must embed
 * an already-published package rather than bumping it.
 */
export function requireNpmDistTagVersion(
  distTagVersion: string | undefined,
  packageName: string,
  tag: NpmDistTag,
): string {
  if (!distTagVersion) {
    throw new Error(`No npm dist-tag "${tag}" for ${packageName}`);
  }
  if (distTagVersion === '0.0.0' || distTagVersion.startsWith('0.0.0-')) {
    throw new Error(`npm dist-tag "${tag}" for ${packageName} is the workspace placeholder (${distTagVersion})`);
  }
  return distTagVersion;
}

export type ResolvePublishVersionOptions = {
  bumpType: BumpType;
  preid?: string;
  gitTagPrefix?: string;
  fromVersion?: string;
  fromLocal?: boolean;
};

export type GitTagBumpResolution = {
  prefix: string;
  baseVersion: string | undefined;
  version: string;
  bumpType: BumpType;
  preid: string;
};

/**
 * Resolve the git-tag prefix for a package (`--git-tag-prefix` or `{name}/`).
 */
export function resolveGitTagPrefix(packageJsonPath: string, gitTagPrefix?: string): string {
  return gitTagPrefix && gitTagPrefix.length > 0
    ? gitTagPrefix
    : defaultGitTagPrefix(readPackageName(packageJsonPath));
}

/**
 * Resolve the next version from git tags (or `--from-version` / `--from-local`).
 */
export function resolveGitTagBump(
  packageJsonPath: string,
  options: ResolvePublishVersionOptions,
): GitTagBumpResolution {
  const prefix = resolveGitTagPrefix(packageJsonPath, options.gitTagPrefix);
  const preid = options.preid ?? '';
  let baseVersion: string | undefined;

  if (options.fromVersion) {
    baseVersion = options.fromVersion;
  } else if (options.fromLocal) {
    baseVersion = readPackageVersion(packageJsonPath);
  } else {
    baseVersion = fetchGitPrefixVersion(prefix, options.preid);
  }

  return {
    prefix,
    baseVersion,
    version: resolveNextPublishVersion(baseVersion, options.bumpType, options.preid),
    bumpType: options.bumpType,
    preid,
  };
}

/**
 * Resolve `--next-version` against the git-tag base for bump-type inference.
 */
export function resolveGitTagNextVersion(
  packageJsonPath: string,
  nextVersion: string,
  options: { preid?: string; gitTagPrefix?: string },
): GitTagBumpResolution {
  const prefix = resolveGitTagPrefix(packageJsonPath, options.gitTagPrefix);
  const preid = options.preid ?? '';
  const version = resolveSpecifiedNextVersion(nextVersion, options.preid);
  const baseVersion = fetchGitPrefixVersion(prefix, options.preid);
  const bumpType = inferBumpType(baseVersion ?? '0.0.0', version);
  return { prefix, baseVersion, version, bumpType, preid };
}

/**
 * Resolve the next version without writing. Uses `--git-tag-prefix` or `{name}/`.
 */
export function resolvePublishVersion(
  packageJsonPath: string,
  options: ResolvePublishVersionOptions,
): string {
  return resolveGitTagBump(packageJsonPath, options).version;
}
// !WITH_GENESYS
