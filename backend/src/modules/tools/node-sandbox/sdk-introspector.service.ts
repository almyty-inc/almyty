import { Injectable, Logger } from '@nestjs/common';
import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';

import {
  SdkMap,
  SdkExport,
  SdkMethod,
  SdkParam,
  SdkProperty,
  SdkType,
} from './types';
import {
  getJsDocDescription,
  hasNonMethodProperties,
  isPromiseType,
  runtimeIntrospect,
} from './sdk-introspector-helpers.helper';
import {
  extractExport,
  resolveAlias,
} from './sdk-introspector-extractors.helper';

@Injectable()
export class SdkIntrospectorService {
  private readonly logger = new Logger(SdkIntrospectorService.name);

  /**
   * Introspect an installed npm package and return a structured SdkMap.
   *
   * @param packageName  npm package name (e.g. "stripe", "@aws-sdk/client-s3")
   * @param basePath     Absolute path to the directory containing node_modules
   */
  introspect(packageName: string, basePath: string): SdkMap {
    const entryFile = this.findTypeEntryPoint(packageName, basePath);

    if (!entryFile) {
      this.logger.warn(
        `No .d.ts entry point found for "${packageName}", falling back to runtime introspection`,
      );
      return runtimeIntrospect(packageName, basePath);
    }

    this.logger.debug(`Introspecting "${packageName}" via ${entryFile}`);

    const program = ts.createProgram([entryFile], {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      declaration: true,
      skipLibCheck: true,
      noResolve: false,
      typeRoots: [path.join(basePath, 'node_modules', '@types')],
    });

    const checker = program.getTypeChecker();
    const sourceFile = program.getSourceFile(entryFile);

    if (!sourceFile) {
      this.logger.warn(`Could not parse source file: ${entryFile}`);
      return {};
    }

    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);

    if (!moduleSymbol) {
      this.logger.warn(`No module symbol found for ${entryFile}`);
      return {};
    }

    const sdkMap: SdkMap = {};
    const exports = checker.getExportsOfModule(moduleSymbol);

    for (const exportSymbol of exports) {
      const name = exportSymbol.getName();
      const resolvedSymbol = resolveAlias(exportSymbol, checker);
      const sdkExport = extractExport(resolvedSymbol, checker);

      if (sdkExport) {
        sdkMap[name] = sdkExport;
      }
    }

    return sdkMap;
  }

  // ---------------------------------------------------------------------------
  // Entry-point resolution
  // ---------------------------------------------------------------------------

  /**
   * Find the .d.ts entry point for a package. Resolution order:
   * 1. package.json "types" or "typings" field
   * 2. index.d.ts in package root
   * 3. dist/index.d.ts
   * 4. @types/* package
   */
  private findTypeEntryPoint(
    packageName: string,
    basePath: string,
  ): string | null {
    const packageDir = path.join(basePath, 'node_modules', packageName);

    // 1. Check package.json types/typings field
    const pkgJsonPath = path.join(packageDir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        const typesField = pkgJson.types || pkgJson.typings;
        if (typesField) {
          const resolved = path.resolve(packageDir, typesField);
          if (fs.existsSync(resolved)) {
            return resolved;
          }
        }
      } catch {
        // ignore parse errors
      }
    }

    // 2. index.d.ts in package root
    const indexDts = path.join(packageDir, 'index.d.ts');
    if (fs.existsSync(indexDts)) {
      return indexDts;
    }

    // 3. dist/index.d.ts
    const distIndexDts = path.join(packageDir, 'dist', 'index.d.ts');
    if (fs.existsSync(distIndexDts)) {
      return distIndexDts;
    }

    // 4. @types package
    const atTypesEntry = this.resolveAtTypesPackage(packageName, basePath);
    if (atTypesEntry) {
      return atTypesEntry;
    }

    return null;
  }

  /**
   * Resolve the @types/* package for a given package name.
   * - Regular packages: lodash -> @types/lodash
   * - Scoped packages: @slack/web-api -> @types/slack__web-api
   */
  private resolveAtTypesPackage(
    packageName: string,
    basePath: string,
  ): string | null {
    let atTypesName: string;
    if (packageName.startsWith('@')) {
      // Scoped: @scope/name -> @types/scope__name
      atTypesName = packageName.slice(1).replace('/', '__');
    } else {
      atTypesName = packageName;
    }

    const atTypesDir = path.join(
      basePath,
      'node_modules',
      '@types',
      atTypesName,
    );

    const pkgJsonPath = path.join(atTypesDir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        const typesField = pkgJson.types || pkgJson.typings;
        if (typesField) {
          const resolved = path.resolve(atTypesDir, typesField);
          if (fs.existsSync(resolved)) {
            return resolved;
          }
        }
      } catch {
        // ignore
      }

      // fallback: index.d.ts
      const indexDts = path.join(atTypesDir, 'index.d.ts');
      if (fs.existsSync(indexDts)) {
        return indexDts;
      }
    }

    return null;
  }

}
