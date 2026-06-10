import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  DependencyInstallResult,
  NpmRegistryConfig,
} from './types';

// Absolute path under the OS tmpdir. Containers often have a read-only
// rootfs with /tmp mounted writable — a relative path would fail mkdir.
const DEFAULT_DEPS_PATH = path.join(os.tmpdir(), 'almyty-tool-deps');
const DEFAULT_INSTALL_TIMEOUT = 120_000; // 2 minutes
const DEFAULT_MAX_CACHE_SIZE_MB = 2048; // 2 GB

// npm package-name grammar (scoped or unscoped). Names can't start with
// `.` or `_`, must be lowercase, and may not contain URL/path characters.
const NPM_NAME_RE =
  /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
// Version specifiers we accept: semver ranges and dist-tags only. The
// character class deliberately excludes `/` and `:`, which rejects every
// dangerous npm "version" form that fetches arbitrary code from outside
// the registry — git+, git:, https:, file:, link:, and `user/repo`
// GitHub shorthand. Those resolve to code that runs when required in the
// worker, so they must not be installable from a user-supplied spec.
const SAFE_VERSION_RE = /^[A-Za-z0-9.\-_+~^*<>=|\sxX]+$/;

@Injectable()
export class DependencyManagerService {
  private readonly logger = new Logger(DependencyManagerService.name);

  /** In-flight installs keyed by cache hash — prevents duplicate parallel work */
  private readonly inFlight = new Map<string, Promise<DependencyInstallResult>>();

  // ──────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────

  /**
   * Ensure the given dependencies are installed and return the install directory.
   * Results are cached on disk; concurrent requests for the same set of deps
   * are deduplicated.
   */
  async ensureInstalled(
    dependencies: Record<string, string>,
    registry?: NpmRegistryConfig,
  ): Promise<DependencyInstallResult> {
    this.validateDependencies(dependencies);
    if (registry) this.validateRegistry(registry);
    const hash = this.hashDeps(dependencies);
    const installDir = path.join(this.basePath(), hash);

    // Fast path — already installed
    if (this.isInstalled(installDir)) {
      this.logger.debug(`Cache hit for ${hash}`);
      return { installDir, cached: true, installTimeMs: 0 };
    }

    // Deduplicate parallel installs for the same hash
    if (this.inFlight.has(hash)) {
      this.logger.debug(`Waiting on in-flight install for ${hash}`);
      return this.inFlight.get(hash)!;
    }

    const promise = this.install(installDir, dependencies, registry, hash);
    this.inFlight.set(hash, promise);

    try {
      return await promise;
    } finally {
      this.inFlight.delete(hash);
    }
  }

  /** List cached dependency sets */
  listCached(): { hash: string; installedAt: string; deps: Record<string, string> }[] {
    const base = this.basePath();
    if (!fs.existsSync(base)) return [];

    const entries: { hash: string; installedAt: string; deps: Record<string, string> }[] = [];
    for (const name of fs.readdirSync(base)) {
      const lockFile = path.join(base, name, '.installed');
      if (fs.existsSync(lockFile)) {
        try {
          const meta = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
          entries.push({
            hash: name,
            installedAt: meta.installedAt,
            deps: meta.dependencies,
          });
        } catch {
          // skip corrupt entries
        }
      }
    }
    return entries;
  }

  /** Remove all cached dependency directories */
  clearCache(): void {
    const base = this.basePath();
    if (fs.existsSync(base)) {
      fs.rmSync(base, { recursive: true, force: true });
      this.logger.log('Dependency cache cleared');
    }
  }

  // ──────────────────────────────────────────────
  // Internal
  // ──────────────────────────────────────────────

  private basePath(): string {
    return process.env.SANDBOX_DEPS_PATH || DEFAULT_DEPS_PATH;
  }

  /** Create a deterministic hash for a set of dependencies (key order independent) */
  private hashDeps(deps: Record<string, string>): string {
    const sorted = Object.keys(deps)
      .sort()
      .map((k) => `${k}@${deps[k]}`)
      .join('\n');
    return crypto.createHash('sha256').update(sorted).digest('hex').slice(0, 16);
  }

  /** Check whether a directory has been fully installed */
  private isInstalled(dir: string): boolean {
    return fs.existsSync(path.join(dir, '.installed'));
  }

  /**
   * Reject any dependency whose name isn't a valid npm package name or
   * whose version isn't a plain semver range / dist-tag. This blocks
   * git/url/file/path/GitHub-shorthand "versions" that npm would fetch
   * and run code from outside the registry.
   */
  private validateDependencies(dependencies: Record<string, string>): void {
    for (const [name, version] of Object.entries(dependencies ?? {})) {
      if (typeof name !== 'string' || name.length === 0 || name.length > 214) {
        throw new BadRequestException(`Invalid dependency name: ${JSON.stringify(name)}`);
      }
      if (!NPM_NAME_RE.test(name)) {
        throw new BadRequestException(`Invalid dependency name: ${name}`);
      }
      if (typeof version !== 'string' || version.trim().length === 0) {
        throw new BadRequestException(`Invalid version for dependency "${name}"`);
      }
      if (!SAFE_VERSION_RE.test(version)) {
        throw new BadRequestException(
          `Unsupported version spec for "${name}": ${version}. ` +
            'Only semver ranges and dist-tags are allowed (no git/url/file/path specs).',
        );
      }
    }
  }

  /**
   * Validate a private-registry config. Reject CR/LF in any field (which
   * would inject arbitrary directives into the generated .npmrc) and
   * require an http(s) registry URL.
   */
  private validateRegistry(registry: NpmRegistryConfig): void {
    const fields = [registry.url, registry.scope, registry.authToken];
    for (const f of fields) {
      if (typeof f === 'string' && /[\r\n]/.test(f)) {
        throw new BadRequestException('Registry config must not contain newlines');
      }
    }
    let parsed: URL;
    try {
      parsed = new URL(registry.url);
    } catch {
      throw new BadRequestException(`Invalid registry URL: ${registry.url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException(`Registry URL must be http(s): ${registry.url}`);
    }
  }

  /** Run the actual npm install */
  private async install(
    installDir: string,
    dependencies: Record<string, string>,
    registry: NpmRegistryConfig | undefined,
    hash: string,
  ): Promise<DependencyInstallResult> {
    const start = Date.now();

    // Create the directory
    fs.mkdirSync(installDir, { recursive: true });

    // Write package.json
    const packageJson = {
      name: `sandbox-deps-${hash}`,
      version: '1.0.0',
      private: true,
      dependencies: { ...dependencies },
    };
    fs.writeFileSync(
      path.join(installDir, 'package.json'),
      JSON.stringify(packageJson, null, 2),
    );

    // Write .npmrc if a private registry is configured
    if (registry) {
      const lines: string[] = [];
      if (registry.scope) {
        lines.push(`${registry.scope}:registry=${registry.url}`);
      } else {
        lines.push(`registry=${registry.url}`);
      }
      if (registry.authToken) {
        // Extract host from URL for auth token line
        const url = new URL(registry.url);
        lines.push(`//${url.host}/:_authToken=${registry.authToken}`);
      }
      fs.writeFileSync(path.join(installDir, '.npmrc'), lines.join('\n') + '\n');
    }

    // Run npm install
    try {
      await this.runNpmInstall(installDir);
    } catch (err: any) {
      // Clean up on failure — do NOT leave a .installed marker
      this.logger.error(`npm install failed for ${hash}: ${err.message}`);
      try {
        fs.rmSync(installDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
      throw err;
    }

    // Auto-install @types/* for packages that are missing bundled declarations
    await this.installMissingTypes(installDir, dependencies);

    // Mark as completed
    const lockData = {
      installedAt: new Date().toISOString(),
      dependencies,
      hash,
    };
    fs.writeFileSync(
      path.join(installDir, '.installed'),
      JSON.stringify(lockData, null, 2),
    );

    const installTimeMs = Date.now() - start;
    this.logger.log(`Installed deps (${hash}) in ${installTimeMs}ms`);

    // Evict old entries if over size limit
    this.evictIfNeeded();

    return { installDir, cached: false, installTimeMs };
  }

  /** Spawn npm install and wait for completion */
  private runNpmInstall(cwd: string): Promise<void> {
    const timeout = parseInt(process.env.SANDBOX_INSTALL_TIMEOUT || '', 10) || DEFAULT_INSTALL_TIMEOUT;

    // CRITICAL: --ignore-scripts is REQUIRED here. The install runs in
    // the HOST process (not the worker_threads sandbox), so any package's
    // preinstall/install/postinstall hook would execute with full backend
    // privileges — env vars, filesystem, network. A user creating a tool
    // with a malicious `dependencies` field could exfiltrate secrets or
    // RCE the backend process. --ignore-scripts disables that vector.
    //
    // --no-package-lock keeps the cache directory free of lock files
    // that would otherwise need management.
    // Force npm to use a writable cache dir under the OS tmpdir.
    // Containers with readOnlyRootFilesystem don't have $HOME/.npm
    // writable, and npm fails to mkdir it before downloading the
    // first package.
    const npmCacheDir = path.join(os.tmpdir(), 'almyty-npm-cache');
    fs.mkdirSync(npmCacheDir, { recursive: true });

    return new Promise<void>((resolve, reject) => {
      const child = spawn(
        'npm',
        [
          'install',
          '--production',
          '--no-audit',
          '--no-fund',
          '--prefer-offline',
          '--ignore-scripts',
          '--no-package-lock',
          `--cache=${npmCacheDir}`,
        ],
        {
          cwd,
          stdio: 'pipe',
          env: {
            ...process.env,
            NODE_ENV: 'production',
            npm_config_cache: npmCacheDir,
          },
        },
      );

      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`npm install timed out after ${timeout}ms`));
      }, timeout);

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`npm install exited with code ${code}: ${stderr.slice(0, 500)}`));
        }
      });
    });
  }

  /**
   * For each dependency, check if it ships its own typings. If not,
   * attempt to install @types/<pkg>. Failures are silently ignored
   * (the package may not have DefinitelyTyped types).
   */
  private async installMissingTypes(
    installDir: string,
    dependencies: Record<string, string>,
  ): Promise<void> {
    const typesToInstall: string[] = [];

    for (const pkg of Object.keys(dependencies)) {
      const pkgJsonPath = path.join(installDir, 'node_modules', pkg, 'package.json');
      if (!fs.existsSync(pkgJsonPath)) continue;

      try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        if (!pkgJson.types && !pkgJson.typings) {
          // Doesn't bundle types — try @types/<pkg>
          const typePkg = `@types/${pkg.replace('@', '').replace('/', '__')}`;
          typesToInstall.push(typePkg);
        }
      } catch {
        // skip
      }
    }

    if (typesToInstall.length === 0) return;

    // Best-effort install — don't fail if @types packages don't exist.
    // Same --ignore-scripts requirement as runNpmInstall: this also runs
    // in the host process and would otherwise execute arbitrary postinstall
    // hooks from the @types/* packages.
    const npmCacheDir = path.join(os.tmpdir(), 'almyty-npm-cache');
    try {
      await new Promise<void>((resolve) => {
        const child = spawn(
          'npm',
          [
            'install',
            '--save-dev',
            '--no-audit',
            '--no-fund',
            '--ignore-scripts',
            '--no-package-lock',
            `--cache=${npmCacheDir}`,
            ...typesToInstall,
          ],
          {
            cwd: installDir,
            stdio: 'pipe',
            env: { ...process.env, npm_config_cache: npmCacheDir },
          },
        );
        child.on('close', () => resolve());
        child.on('error', () => resolve());
      });
    } catch {
      // ignore
    }
  }

  /** Evict oldest cache entries when total size exceeds the limit */
  private evictIfNeeded(): void {
    const maxMb =
      parseInt(process.env.SANDBOX_MAX_CACHE_SIZE_MB || '', 10) || DEFAULT_MAX_CACHE_SIZE_MB;
    const maxBytes = maxMb * 1024 * 1024;
    const base = this.basePath();

    if (!fs.existsSync(base)) return;

    // Collect entries with their size and mtime
    const entries: { name: string; size: number; mtime: number }[] = [];
    for (const name of fs.readdirSync(base)) {
      const dir = path.join(base, name);
      try {
        const stat = fs.statSync(dir);
        if (!stat.isDirectory()) continue;
        const size = this.dirSize(dir);
        entries.push({ name, size, mtime: stat.mtimeMs });
      } catch {
        // skip
      }
    }

    let totalSize = entries.reduce((sum, e) => sum + e.size, 0);
    if (totalSize <= maxBytes) return;

    // Sort oldest first
    entries.sort((a, b) => a.mtime - b.mtime);

    for (const entry of entries) {
      if (totalSize <= maxBytes) break;
      const dir = path.join(base, entry.name);
      this.logger.log(`Evicting cache entry ${entry.name} (${(entry.size / 1024 / 1024).toFixed(1)}MB)`);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        totalSize -= entry.size;
      } catch {
        // best effort
      }
    }
  }

  /** Recursively compute directory size */
  private dirSize(dir: string): number {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += this.dirSize(full);
      } else {
        try {
          total += fs.statSync(full).size;
        } catch {
          // skip
        }
      }
    }
    return total;
  }
}
