import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  DependencyInstallResult,
  NpmRegistryConfig,
} from './types';

const DEFAULT_DEPS_PATH = '.tool-deps';
const DEFAULT_INSTALL_TIMEOUT = 120_000; // 2 minutes
const DEFAULT_MAX_CACHE_SIZE_MB = 2048; // 2 GB

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

    return new Promise<void>((resolve, reject) => {
      const child = spawn('npm', ['install', '--production', '--no-audit', '--no-fund', '--prefer-offline'], {
        cwd,
        stdio: 'pipe',
        env: { ...process.env, NODE_ENV: 'production' },
      });

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

    // Best-effort install — don't fail if @types packages don't exist
    try {
      await new Promise<void>((resolve) => {
        const child = spawn(
          'npm',
          ['install', '--save-dev', '--no-audit', '--no-fund', ...typesToInstall],
          { cwd: installDir, stdio: 'pipe' },
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
