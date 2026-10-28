import * as ts from 'typescript';

/**
 * Pure TS-AST predicates and the JSDoc reader, extracted from
 * SdkIntrospectorService. Plain functions; no DI.
 *
 * There is deliberately no runtime fallback here. One used to exist: for
 * a package without type declarations it did `require()` on the package
 * inside the backend process, which runs the package's entry file with
 * the API server's privileges. Introspection reads declarations only.
 */

/**
 * A type as text, or 'unknown' when the checker cannot print it.
 *
 * typeToString recurses through the type; on a recursive generic it blows
 * the stack (eventemitter3's EventEmitter<EventTypes> does: RangeError
 * "Maximum call stack size exceeded"), and that took the whole package
 * down with it. One type that cannot be printed is one type shown as
 * unknown, not a failed analysis. Output is capped for the same reason.
 */
export function typeText(type: ts.Type, checker: ts.TypeChecker): string {
  try {
    const raw = checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTypeReduction);
    return raw.length > 500 ? `${raw.slice(0, 497)}...` : raw;
  } catch {
    return 'unknown';
  }
}

/** Check whether a type is a Promise<T>. */
export function isPromiseType(type: ts.Type, checker: ts.TypeChecker): boolean {
  const symbol = type.getSymbol();
  if (symbol && symbol.getName() === 'Promise') {
    return true;
  }
  const raw = typeText(type, checker);
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
