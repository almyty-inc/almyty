import * as ts from 'typescript';
import * as path from 'path';
import { Logger } from '@nestjs/common';

import { SdkMap, SdkMethod, SdkParam } from './types';

/**
 * Pure helpers extracted from SdkIntrospectorService:
 * — runtime introspection fallback
 * — small TS-AST predicates and JSDoc reader
 *
 * Plain functions; no DI. The runtime fallback owns its own Logger
 * because it can fail in ways the caller wants to see.
 */

const runtimeLogger = new Logger('SdkIntrospectorRuntime');

/** Check whether a type is a Promise<T>. */
export function isPromiseType(type: ts.Type, checker: ts.TypeChecker): boolean {
  const symbol = type.getSymbol();
  if (symbol && symbol.getName() === 'Promise') {
    return true;
  }
  const raw = checker.typeToString(type);
  return raw.startsWith('Promise<');
}

/**
 * Return true if the type has properties beyond the built-in Function
 * prototype members (bind, call, apply, etc.). Used to distinguish
 * pure function types from objects-with-methods.
 */
export function hasNonMethodProperties(type: ts.Type): boolean {
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

/** Extract JSDoc description from a symbol. */
export function getJsDocDescription(symbol: ts.Symbol): string | undefined {
  const docs = symbol.getDocumentationComment(undefined);
  if (docs && docs.length > 0) {
    return docs.map((d) => d.text).join('\n');
  }
  return undefined;
}

/**
 * Fallback for packages without .d.ts and no @types: require the
 * module and inspect exported values at runtime.
 */
export function runtimeIntrospect(packageName: string, basePath: string): SdkMap {
  try {
    const modulePath = path.join(basePath, 'node_modules', packageName);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(modulePath);
    const sdkMap: SdkMap = {};

    for (const key of Object.keys(mod)) {
      const value = mod[key];
      if (typeof value === 'function') {
        const protoMethods = Object.getOwnPropertyNames(value.prototype || {}).filter(
          (m) => m !== 'constructor' && typeof value.prototype[m] === 'function',
        );

        if (protoMethods.length > 0) {
          const methods: SdkMethod[] = protoMethods.map((m) => ({
            name: m,
            params: inferParamsFromFunction(value.prototype[m]),
            returnType: { raw: 'unknown', kind: 'unknown' as const },
            isAsync: value.prototype[m].constructor.name === 'AsyncFunction',
            isStatic: false,
          }));

          sdkMap[key] = {
            name: key,
            constructorParams: inferParamsFromFunction(value),
            methods,
            properties: [],
            isClass: true,
            isFunction: false,
          };
        } else {
          sdkMap[key] = {
            name: key,
            constructorParams: [],
            methods: [
              {
                name: key,
                params: inferParamsFromFunction(value),
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
  } catch (err: any) {
    runtimeLogger.error(`Runtime introspection failed for "${packageName}": ${err.message}`);
    return {};
  }
}

/**
 * Best-effort parameter inference from a runtime function.
 * Parses the function's .toString() to extract parameter names.
 */
export function inferParamsFromFunction(fn: Function): SdkParam[] {
  try {
    const src = fn.toString();
    const match = src.match(/\(([^)]*)\)/);
    if (!match || !match[1].trim()) return [];

    return match[1].split(',').map((p) => {
      const trimmed = p.trim().replace(/=.*$/, '').replace(/\.\.\./, '');
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
