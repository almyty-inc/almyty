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

/** Maximum depth for recursive type resolution to prevent infinite loops */
const MAX_TYPE_DEPTH = 3;

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
      return this.runtimeIntrospect(packageName, basePath);
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
      const resolvedSymbol = this.resolveAlias(exportSymbol, checker);
      const sdkExport = this.extractExport(resolvedSymbol, checker);

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

  // ---------------------------------------------------------------------------
  // Export extraction
  // ---------------------------------------------------------------------------

  private resolveAlias(
    symbol: ts.Symbol,
    checker: ts.TypeChecker,
  ): ts.Symbol {
    if (symbol.flags & ts.SymbolFlags.Alias) {
      return checker.getAliasedSymbol(symbol);
    }
    return symbol;
  }

  private extractExport(
    symbol: ts.Symbol,
    checker: ts.TypeChecker,
  ): SdkExport | null {
    const name = symbol.getName();
    const description = this.getJsDocDescription(symbol);

    // Check if it's a class
    if (symbol.flags & ts.SymbolFlags.Class) {
      return this.extractClass(symbol, checker, name, description);
    }

    // Check if it's a function
    if (symbol.flags & ts.SymbolFlags.Function) {
      return this.extractFunction(symbol, checker, name, description);
    }

    // Check if it's a namespace/module with nested exports
    if (
      symbol.flags & ts.SymbolFlags.NamespaceModule ||
      symbol.flags & ts.SymbolFlags.ValueModule
    ) {
      return this.extractNamespace(symbol, checker, name, description);
    }

    // Check if it's a variable (could be a class or function assigned to a var)
    if (symbol.flags & ts.SymbolFlags.Variable) {
      const decl = symbol.valueDeclaration;
      if (decl) {
        const type = checker.getTypeOfSymbolAtLocation(symbol, decl);
        const constructSignatures = type.getConstructSignatures();
        if (constructSignatures.length > 0) {
          return this.extractClassFromType(type, checker, name, description);
        }

        const callSignatures = type.getCallSignatures();
        if (callSignatures.length > 0) {
          return this.extractFunctionFromSignature(
            callSignatures[0],
            checker,
            name,
            description,
          );
        }
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Class extraction
  // ---------------------------------------------------------------------------

  private extractClass(
    symbol: ts.Symbol,
    checker: ts.TypeChecker,
    name: string,
    description?: string,
  ): SdkExport {
    const decl = symbol.valueDeclaration;
    const type = decl
      ? checker.getTypeOfSymbolAtLocation(symbol, decl)
      : checker.getDeclaredTypeOfSymbol(symbol);

    return this.extractClassFromType(type, checker, name, description);
  }

  private extractClassFromType(
    type: ts.Type,
    checker: ts.TypeChecker,
    name: string,
    description?: string,
  ): SdkExport {
    // Constructor params
    const constructorParams: SdkParam[] = [];
    const constructSignatures = type.getConstructSignatures();
    if (constructSignatures.length > 0) {
      const ctorSig = constructSignatures[0];
      for (const param of ctorSig.getParameters()) {
        constructorParams.push(this.extractParam(param, checker));
      }
    }

    // Instance type for methods and properties
    const instanceType =
      constructSignatures.length > 0
        ? constructSignatures[0].getReturnType()
        : type;

    const methods: SdkMethod[] = [];
    const properties: SdkProperty[] = [];

    for (const prop of instanceType.getProperties()) {
      const propName = prop.getName();
      // Skip internal/private members
      if (propName.startsWith('_') || propName.startsWith('#')) continue;

      const propDecl = prop.valueDeclaration;
      if (!propDecl) continue;

      const propType = checker.getTypeOfSymbolAtLocation(prop, propDecl);

      // Check if it's a method (has call signatures and no non-method properties)
      const callSignatures = propType.getCallSignatures();
      if (
        callSignatures.length > 0 &&
        !this.hasNonMethodProperties(propType)
      ) {
        methods.push(
          this.extractMethodFromSignature(
            propName,
            callSignatures[0],
            checker,
            prop,
          ),
        );
      } else {
        // It's a property (could be a chained API sub-object with methods)
        properties.push(this.extractProperty(prop, checker));
      }
    }

    return {
      name,
      constructorParams,
      methods,
      properties,
      isClass: true,
      isFunction: false,
      description,
    };
  }

  // ---------------------------------------------------------------------------
  // Function extraction
  // ---------------------------------------------------------------------------

  private extractFunction(
    symbol: ts.Symbol,
    checker: ts.TypeChecker,
    name: string,
    description?: string,
  ): SdkExport {
    const decl = symbol.valueDeclaration;
    if (!decl) {
      return {
        name,
        constructorParams: [],
        methods: [],
        properties: [],
        isClass: false,
        isFunction: true,
        description,
      };
    }

    const type = checker.getTypeOfSymbolAtLocation(symbol, decl);
    const callSignatures = type.getCallSignatures();

    if (callSignatures.length === 0) {
      return {
        name,
        constructorParams: [],
        methods: [],
        properties: [],
        isClass: false,
        isFunction: true,
        description,
      };
    }

    return this.extractFunctionFromSignature(
      callSignatures[0],
      checker,
      name,
      description,
    );
  }

  private extractFunctionFromSignature(
    sig: ts.Signature,
    checker: ts.TypeChecker,
    name: string,
    description?: string,
  ): SdkExport {
    const params: SdkParam[] = sig
      .getParameters()
      .map((p) => this.extractParam(p, checker));

    const returnType = this.resolveType(sig.getReturnType(), checker, 0);

    const method: SdkMethod = {
      name,
      params,
      returnType,
      isAsync: this.isPromiseType(sig.getReturnType(), checker),
      isStatic: false,
      description,
    };

    return {
      name,
      constructorParams: [],
      methods: [method],
      properties: [],
      isClass: false,
      isFunction: true,
      description,
    };
  }

  // ---------------------------------------------------------------------------
  // Namespace extraction
  // ---------------------------------------------------------------------------

  private extractNamespace(
    symbol: ts.Symbol,
    checker: ts.TypeChecker,
    name: string,
    description?: string,
  ): SdkExport {
    const methods: SdkMethod[] = [];
    const properties: SdkProperty[] = [];

    const exports = checker.getExportsOfModule(symbol);
    for (const exp of exports) {
      const resolved = this.resolveAlias(exp, checker);
      const expName = resolved.getName();
      const expDecl = resolved.valueDeclaration;
      if (!expDecl) continue;

      const expType = checker.getTypeOfSymbolAtLocation(resolved, expDecl);
      const callSigs = expType.getCallSignatures();

      if (callSigs.length > 0) {
        methods.push(
          this.extractMethodFromSignature(
            expName,
            callSigs[0],
            checker,
            resolved,
          ),
        );
      } else {
        properties.push(this.extractProperty(resolved, checker));
      }
    }

    return {
      name,
      constructorParams: [],
      methods,
      properties,
      isClass: false,
      isFunction: false,
      description,
    };
  }

  // ---------------------------------------------------------------------------
  // Method & param extraction
  // ---------------------------------------------------------------------------

  private extractMethodFromSignature(
    name: string,
    sig: ts.Signature,
    checker: ts.TypeChecker,
    symbol?: ts.Symbol,
  ): SdkMethod {
    const params = sig
      .getParameters()
      .map((p) => this.extractParam(p, checker));
    const returnType = this.resolveType(sig.getReturnType(), checker, 0);
    const description = symbol
      ? this.getJsDocDescription(symbol)
      : undefined;

    return {
      name,
      params,
      returnType,
      isAsync: this.isPromiseType(sig.getReturnType(), checker),
      isStatic: false,
      description,
    };
  }

  private extractParam(
    paramSymbol: ts.Symbol,
    checker: ts.TypeChecker,
  ): SdkParam {
    const name = paramSymbol.getName();
    const decl = paramSymbol.valueDeclaration;
    const optional = decl
      ? checker.isOptionalParameter(decl as ts.ParameterDeclaration)
      : false;

    let type: SdkType = { raw: 'unknown', kind: 'unknown' };
    if (decl) {
      let paramType = checker.getTypeOfSymbolAtLocation(paramSymbol, decl);
      // Optional params are typed as `T | undefined` since TS 6.
      // Unwrap to the underlying type so introspection stays stable.
      if (optional) paramType = paramType.getNonNullableType();
      type = this.resolveType(paramType, checker, 0);
    }

    return { name, type, optional };
  }

  private extractProperty(
    symbol: ts.Symbol,
    checker: ts.TypeChecker,
  ): SdkProperty {
    const name = symbol.getName();
    const decl = symbol.valueDeclaration;
    const description = this.getJsDocDescription(symbol);

    let readonly = false;
    if (decl && ts.isPropertyDeclaration(decl)) {
      readonly = !!decl.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.ReadonlyKeyword,
      );
    }

    let type: SdkType = { raw: 'unknown', kind: 'unknown' };
    if (decl) {
      const propType = checker.getTypeOfSymbolAtLocation(symbol, decl);
      type = this.resolveType(propType, checker, 0);
    }

    return { name, type, readonly, description };
  }

  // ---------------------------------------------------------------------------
  // Type resolution
  // ---------------------------------------------------------------------------

  private resolveType(
    type: ts.Type,
    checker: ts.TypeChecker,
    depth: number,
  ): SdkType {
    if (depth >= MAX_TYPE_DEPTH) {
      return { raw: checker.typeToString(type), kind: 'unknown' };
    }

    const raw = checker.typeToString(type);

    // Unwrap Promise<T>
    if (this.isPromiseType(type, checker)) {
      const typeArgs = (type as ts.TypeReference).typeArguments;
      if (typeArgs && typeArgs.length > 0) {
        return this.resolveType(typeArgs[0], checker, depth);
      }
    }

    // Primitives
    if (
      type.flags & ts.TypeFlags.String ||
      type.flags & ts.TypeFlags.StringLiteral
    ) {
      return { raw: 'string', kind: 'primitive' };
    }
    if (
      type.flags & ts.TypeFlags.Number ||
      type.flags & ts.TypeFlags.NumberLiteral
    ) {
      return { raw: 'number', kind: 'primitive' };
    }
    if (
      type.flags & ts.TypeFlags.Boolean ||
      type.flags & ts.TypeFlags.BooleanLiteral
    ) {
      return { raw: 'boolean', kind: 'primitive' };
    }
    if (type.flags & ts.TypeFlags.Void) {
      return { raw: 'void', kind: 'primitive' };
    }
    if (type.flags & ts.TypeFlags.Null) {
      return { raw: 'null', kind: 'primitive' };
    }
    if (type.flags & ts.TypeFlags.Undefined) {
      return { raw: 'undefined', kind: 'primitive' };
    }
    if (type.flags & ts.TypeFlags.Any) {
      return { raw: 'any', kind: 'unknown' };
    }

    // Buffer
    if (raw === 'Buffer') {
      return { raw: 'Buffer', kind: 'primitive' };
    }

    // Union type: check if all members are string literals (enum)
    if (type.isUnion()) {
      const members = type.types;
      const allStringLiterals = members.every(
        (m) => m.flags & ts.TypeFlags.StringLiteral,
      );
      if (allStringLiterals) {
        const enumValues = members.map(
          (m) => (m as ts.StringLiteralType).value,
        );
        return { raw, kind: 'enum', enumValues };
      }

      // Regular union
      const unionTypes = members.map((m) =>
        this.resolveType(m, checker, depth + 1),
      );
      return { raw, kind: 'union', unionTypes };
    }

    // Array type
    if (checker.isArrayType(type)) {
      const typeArgs = (type as ts.TypeReference).typeArguments;
      const elementType =
        typeArgs && typeArgs.length > 0
          ? this.resolveType(typeArgs[0], checker, depth + 1)
          : ({ raw: 'any', kind: 'unknown' } as SdkType);
      return { raw, kind: 'array', elementType };
    }

    // Class reference
    const symbol = type.getSymbol();
    if (symbol && symbol.flags & ts.SymbolFlags.Class) {
      return { raw, kind: 'class_reference', className: symbol.getName() };
    }

    // Function type (has call signatures but no non-builtin properties)
    const callSigs = type.getCallSignatures();
    if (callSigs.length > 0 && !this.hasNonMethodProperties(type)) {
      return { raw, kind: 'function' };
    }

    // Object type with properties
    const typeProperties = type.getProperties();
    if (typeProperties.length > 0) {
      const sdkProperties: SdkProperty[] = [];
      const sdkMethods: SdkMethod[] = [];

      for (const prop of typeProperties) {
        const propName = prop.getName();
        if (propName.startsWith('_') || propName.startsWith('#')) continue;

        const propDecl = prop.valueDeclaration;
        if (!propDecl) continue;

        const propType = checker.getTypeOfSymbolAtLocation(prop, propDecl);
        const propCallSigs = propType.getCallSignatures();

        if (
          propCallSigs.length > 0 &&
          !this.hasNonMethodProperties(propType)
        ) {
          sdkMethods.push(
            this.extractMethodFromSignature(
              propName,
              propCallSigs[0],
              checker,
              prop,
            ),
          );
        } else {
          const resolved = this.resolveType(propType, checker, depth + 1);
          const desc = this.getJsDocDescription(prop);
          const isReadonly =
            propDecl &&
            ts.isPropertySignature(propDecl) &&
            !!propDecl.modifiers?.some(
              (m) => m.kind === ts.SyntaxKind.ReadonlyKeyword,
            );

          sdkProperties.push({
            name: propName,
            type: resolved,
            readonly: !!isReadonly,
            description: desc,
          });
        }
      }

      return {
        raw,
        kind: 'object',
        properties: sdkProperties.length > 0 ? sdkProperties : undefined,
        methods: sdkMethods.length > 0 ? sdkMethods : undefined,
      };
    }

    return { raw, kind: 'unknown' };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Check whether a type is a Promise<T> */
  private isPromiseType(type: ts.Type, checker: ts.TypeChecker): boolean {
    const symbol = type.getSymbol();
    if (symbol && symbol.getName() === 'Promise') {
      return true;
    }
    // Also handle type aliases resolving to Promise
    const raw = checker.typeToString(type);
    return raw.startsWith('Promise<');
  }

  /**
   * Return true if the type has properties beyond the built-in Function
   * prototype members (bind, call, apply, etc.). Used to distinguish pure
   * function types from objects-with-methods.
   */
  private hasNonMethodProperties(type: ts.Type): boolean {
    const builtins = new Set([
      'bind',
      'call',
      'apply',
      'prototype',
      'length',
      'name',
      'arguments',
      'caller',
    ]);
    for (const p of type.getProperties()) {
      if (!builtins.has(p.getName())) {
        return true;
      }
    }
    return false;
  }

  /** Extract JSDoc description from a symbol */
  private getJsDocDescription(symbol: ts.Symbol): string | undefined {
    const docs = symbol.getDocumentationComment(undefined);
    if (docs && docs.length > 0) {
      return docs.map((d) => d.text).join('\n');
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Runtime introspection fallback
  // ---------------------------------------------------------------------------

  /**
   * Fallback for packages without .d.ts and no @types: require the module
   * and inspect exported values at runtime.
   */
  private runtimeIntrospect(
    packageName: string,
    basePath: string,
  ): SdkMap {
    try {
      const modulePath = path.join(basePath, 'node_modules', packageName);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(modulePath);
      const sdkMap: SdkMap = {};

      for (const key of Object.keys(mod)) {
        const value = mod[key];
        if (typeof value === 'function') {
          // Heuristic: if prototype has methods beyond constructor, treat as class
          const protoMethods = Object.getOwnPropertyNames(
            value.prototype || {},
          ).filter(
            (m) =>
              m !== 'constructor' &&
              typeof value.prototype[m] === 'function',
          );

          if (protoMethods.length > 0) {
            const methods: SdkMethod[] = protoMethods.map((m) => ({
              name: m,
              params: this.inferParamsFromFunction(value.prototype[m]),
              returnType: { raw: 'unknown', kind: 'unknown' as const },
              isAsync:
                value.prototype[m].constructor.name === 'AsyncFunction',
              isStatic: false,
            }));

            sdkMap[key] = {
              name: key,
              constructorParams: this.inferParamsFromFunction(value),
              methods,
              properties: [],
              isClass: true,
              isFunction: false,
            };
          } else {
            // Plain function
            sdkMap[key] = {
              name: key,
              constructorParams: [],
              methods: [
                {
                  name: key,
                  params: this.inferParamsFromFunction(value),
                  returnType: { raw: 'unknown', kind: 'unknown' },
                  isAsync: value.constructor.name === 'AsyncFunction',
                  isStatic: false,
                },
              ],
              properties: [],
              isClass: false,
              isFunction: true,
            };
          }
        }
      }

      return sdkMap;
    } catch (err) {
      this.logger.error(
        `Runtime introspection failed for "${packageName}": ${err.message}`,
      );
      return {};
    }
  }

  /**
   * Best-effort parameter inference from a runtime function.
   * Parses the function's .toString() to extract parameter names.
   */
  private inferParamsFromFunction(fn: Function): SdkParam[] {
    try {
      const src = fn.toString();
      const match = src.match(/\(([^)]*)\)/);
      if (!match || !match[1].trim()) return [];

      return match[1].split(',').map((p) => {
        const trimmed = p
          .trim()
          .replace(/=.*$/, '')
          .replace(/\.\.\./, '');
        const optional = p.includes('=') || p.includes('...');
        return {
          name: trimmed || 'arg',
          type: { raw: 'unknown', kind: 'unknown' as const },
          optional,
        };
      });
    } catch {
      return [];
    }
  }
}
