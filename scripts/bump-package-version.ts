// WITH_GENESYS
/**
 * Keep in sync with genesys-monorepo scripts/bump-package-version.ts.
 * Copied into this nested repo so the Publish workflow can bump from git tags
 * without depending on the parent monorepo checkout.
 */
/**
 * CLI: bump a package.json version from git tags (or an explicit current version).
 *
 * @module scripts/bump-package-version
 */

import { appendFileSync } from 'node:fs';

import { Command } from 'commander';

import {
  fetchNpmDistTagVersion,
  isBumpType,
  isNpmDistTag,
  readPackageBinName,
  readPackageName,
  requireNpmDistTagVersion,
  resolveGitTagBump,
  resolveGitTagNextVersion,
  resolvePackageJsonPath,
  writePackageVersion,
  type GitTagBumpResolution,
} from './publish-version.js';

const program = new Command();

program
  .name('bump-package-version')
  .description(
    'Set a package.json version from git tags (or --set / --next-version / --sync-npm-tag / --from-local). Does not commit.',
  )
  .argument('<package>', 'Package directory or package.json path')
  .argument('[bump]', 'Bump type: major, minor, or patch (omit when using --set, --sync-npm-tag, or --next-version)')
  .option('--preid <id>', 'Prerelease identifier when the current version has none')
  .option('--git-tag-prefix <prefix>', 'Git tag prefix to bump from (default: {package-name}/)')
  .option('--from-version <version>', 'Bump from this version instead of git tags')
  .option('--from-local', 'Bump from the current package.json version (publish retry)')
  .option('--set <version>', 'Write this version without bumping')
  .option('--next-version <version>', 'Write this version (major, major.minor, or major.minor.patch); prerelease from --preid')
  .option('--sync-npm-tag <tag>', 'Write the current dist-tag version without bumping')
  .action((
    packagePath: string,
    bump: string | undefined,
    options: {
      preid?: string;
      gitTagPrefix?: string;
      fromVersion?: string;
      fromLocal?: boolean;
      set?: string;
      nextVersion?: string;
      syncNpmTag?: string;
    },
  ) => {
    const packageJsonPath = resolvePackageJsonPath(packagePath);

    if (options.set && options.syncNpmTag) {
      throw new Error('Use either --set or --sync-npm-tag, not both.');
    }

    if (options.nextVersion && (options.set || options.syncNpmTag || options.fromVersion || options.fromLocal)) {
      throw new Error('Use --next-version alone, without --set, --sync-npm-tag, --from-version, or --from-local.');
    }

    if (options.nextVersion && bump) {
      throw new Error('Omit the bump argument when using --next-version.');
    }

    if (options.set) {
      writePackageVersion(packageJsonPath, options.set);
      console.error(`Set version -> ${options.set}`);
      return;
    }

    if (options.nextVersion) {
      const resolution = resolveGitTagNextVersion(packageJsonPath, options.nextVersion, {
        preid: options.preid,
        gitTagPrefix: options.gitTagPrefix,
      });
      writePackageVersion(packageJsonPath, resolution.version);
      writeBumpResult(packagePath, packageJsonPath, resolution);
      return;
    }

    if (options.syncNpmTag) {
      if (!isNpmDistTag(options.syncNpmTag)) {
        throw new Error(`Unsupported --sync-npm-tag: ${options.syncNpmTag}. Expected latest, dev, or staging.`);
      }
      const name = readPackageName(packageJsonPath);
      const version = requireNpmDistTagVersion(
        fetchNpmDistTagVersion(name, options.syncNpmTag),
        name,
        options.syncNpmTag,
      );
      writePackageVersion(packageJsonPath, version);
      console.error(`Synced ${options.syncNpmTag} -> ${version}`);
      return;
    }

    if (!bump || !isBumpType(bump)) {
      throw new Error('Bump type is required unless --set, --sync-npm-tag, or --next-version is used. Expected major, minor, or patch.');
    }

    const resolution = resolveGitTagBump(packageJsonPath, {
      bumpType: bump,
      preid: options.preid,
      gitTagPrefix: options.gitTagPrefix,
      fromVersion: options.fromVersion,
      fromLocal: options.fromLocal === true,
    });
    writePackageVersion(packageJsonPath, resolution.version);
    if (options.fromLocal || options.fromVersion) {
      console.error(`Bumped -> ${resolution.version}`);
    } else {
      writeBumpResult(packagePath, packageJsonPath, resolution);
    }
  });

function writeBumpResult(
  packagePath: string,
  packageJsonPath: string,
  resolution: GitTagBumpResolution,
): void {
  const preidLabel = resolution.preid.length > 0 ? resolution.preid : '(none)';
  const displayPath = packagePath.replace(/[/\\]package\.json$/i, '');
  const baseLabel = resolution.baseVersion ?? 'missing (using 0.0.0)';
  console.error(`Bumping ${displayPath} (${resolution.bumpType})`);
  console.error(`- source: git tag prefix '${resolution.prefix}' (preid=${preidLabel})`);
  console.error(`- ${baseLabel} -> ${resolution.version}`);

  writeGitHubOutput('base_source', `git-tag ${resolution.prefix}`);
  writeGitHubOutput('base_version', resolution.baseVersion ?? 'missing');
  writeGitHubOutput('bump_type', resolution.bumpType);
  writeGitHubOutput('preid', resolution.preid);
  writeGitHubOutput('new_version', resolution.version);
  writeGitHubOutput('package_name', readPackageName(packageJsonPath));
  writeGitHubOutput('bin_name', readPackageBinName(packageJsonPath));
}

function writeGitHubOutput(name: string, value: string): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  appendFileSync(outputPath, `${name}=${value}\n`);
}

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
// !WITH_GENESYS
