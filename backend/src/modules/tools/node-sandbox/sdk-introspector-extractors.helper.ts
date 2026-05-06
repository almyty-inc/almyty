import * as ts from 'typescript';

import { SdkExport, SdkMethod, SdkParam, SdkProperty, SdkType } from './types';
import {
  getJsDocDescription,
  hasNonMethodProperties,
  isPromiseType,
} from './sdk-introspector-helpers.helper';

/** Maximum depth for recursive type resolution to prevent infinite loops */
const MAX_TYPE_DEPTH = 3;

/**
 * SDK extractors and type resolver, factored out of SdkIntrospectorService
 * so the service can stay focused on entry-point resolution and
 * runtime fallback. All functions here are pure (TS-checker in, JSON
 * out) — no DI, no Nest decorators.
 */

export function resolveAlias(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  if (symbol.flags & ts.SymbolFlags.Alias) {
    return checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

export function extractExport(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): SdkExport | null {
  const name = symbol.getName();
  const description = getJsDocDescription(symbol);

  if (symbol.flags & ts.SymbolFlags.Class) {
    return extractClass(symbol, checker, name, description);
  }

  if (symbol.flags & ts.SymbolFlags.Function) {
    return extractFunction(symbol, checker, name, description);
  }

  if (
    symbol.flags & ts.SymbolFlags.NamespaceModule ||
    symbol.flags & ts.SymbolFlags.ValueModule
  ) {
    return extractNamespace(symbol, checker, name, description);
  }

  if (symbol.flags & ts.SymbolFlags.Variable) {
    const decl = symbol.valueDeclaration;
    if (decl) {
      const type = checker.getTypeOfSymbolAtLocation(symbol, decl);
      const constructSignatures = type.getConstructSignatures();
      if (constructSignatures.length > 0) {
        return extractClassFromType(type, checker, name, description);
      }

      const callSignatures = type.getCallSignatures();
      if (callSignatures.length > 0) {
        return extractFunctionFromSignature(callSignatures[0], checker, name, description);
      }
    }
  }

  return null;
}

function extractClass(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  name: string,
  description?: string,
): SdkExport {
  const decl = symbol.valueDeclaration;
  const type = decl
    ? checker.getTypeOfSymbolAtLocation(symbol, decl)
    : checker.getDeclaredTypeOfSymbol(symbol);

  return extractClassFromType(type, checker, name, description);
}

function extractClassFromType(
  type: ts.Type,
  checker: ts.TypeChecker,
  name: string,
  description?: string,
): SdkExport {
  const constructorParams: SdkParam[] = [];
  const constructSignatures = type.getConstructSignatures();
  if (constructSignatures.length > 0) {
    const ctorSig = constructSignatures[0];
    for (const param of ctorSig.getParameters()) {
      constructorParams.push(extractParam(param, checker));
    }
  }

  const instanceType =
    constructSignatures.length > 0 ? constructSignatures[0].getReturnType() : type;

  const methods: SdkMethod[] = [];
  const properties: SdkProperty[] = [];

  for (const prop of instanceType.getProperties()) {
    const propName = prop.getName();
    if (propName.startsWith('_') || propName.startsWith('#')) continue;

    const propDecl = prop.valueDeclaration;
    if (!propDecl) continue;

    const propType = checker.getTypeOfSymbolAtLocation(prop, propDecl);

    const callSignatures = propType.getCallSignatures();
    if (callSignatures.length > 0 && !hasNonMethodProperties(propType)) {
      methods.push(extractMethodFromSignature(propName, callSignatures[0], checker, prop));
    } else {
      properties.push(extractProperty(prop, checker));
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

function extractFunction(
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

  return extractFunctionFromSignature(callSignatures[0], checker, name, description);
}

function extractFunctionFromSignature(
  sig: ts.Signature,
  checker: ts.TypeChecker,
  name: string,
  description?: string,
): SdkExport {
  const params: SdkParam[] = sig.getParameters().map((p) => extractParam(p, checker));
  const returnType = resolveType(sig.getReturnType(), checker, 0);

  const method: SdkMethod = {
    name,
    params,
    returnType,
    isAsync: isPromiseType(sig.getReturnType(), checker),
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

function extractNamespace(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  name: string,
  description?: string,
): SdkExport {
  const methods: SdkMethod[] = [];
  const properties: SdkProperty[] = [];

  const exports = checker.getExportsOfModule(symbol);
  for (const exp of exports) {
    const resolved = resolveAlias(exp, checker);
    const expName = resolved.getName();
    const expDecl = resolved.valueDeclaration;
    if (!expDecl) continue;

    const expType = checker.getTypeOfSymbolAtLocation(resolved, expDecl);
    const callSigs = expType.getCallSignatures();

    if (callSigs.length > 0) {
      methods.push(extractMethodFromSignature(expName, callSigs[0], checker, resolved));
    } else {
      properties.push(extractProperty(resolved, checker));
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

function extractMethodFromSignature(
  name: string,
  sig: ts.Signature,
  checker: ts.TypeChecker,
  symbol?: ts.Symbol,
): SdkMethod {
  const params = sig.getParameters().map((p) => extractParam(p, checker));
  const returnType = resolveType(sig.getReturnType(), checker, 0);
  const description = symbol ? getJsDocDescription(symbol) : undefined;

  return {
    name,
    params,
    returnType,
    isAsync: isPromiseType(sig.getReturnType(), checker),
    isStatic: false,
    description,
  };
}

function extractParam(paramSymbol: ts.Symbol, checker: ts.TypeChecker): SdkParam {
  const name = paramSymbol.getName();
  const decl = paramSymbol.valueDeclaration;
  const optional = decl
    ? checker.isOptionalParameter(decl as ts.ParameterDeclaration)
    : false;

  let type: SdkType = { raw: 'unknown', kind: 'unknown' };
  if (decl) {
    let paramType = checker.getTypeOfSymbolAtLocation(paramSymbol, decl);
    if (optional) paramType = paramType.getNonNullableType();
    type = resolveType(paramType, checker, 0);
  }

  return { name, type, optional };
}

function extractProperty(symbol: ts.Symbol, checker: ts.TypeChecker): SdkProperty {
  const name = symbol.getName();
  const decl = symbol.valueDeclaration;
  const description = getJsDocDescription(symbol);

  let readonly = false;
  if (decl && ts.isPropertyDeclaration(decl)) {
    readonly = !!decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword);
  }

  let type: SdkType = { raw: 'unknown', kind: 'unknown' };
  if (decl) {
    const propType = checker.getTypeOfSymbolAtLocation(symbol, decl);
    type = resolveType(propType, checker, 0);
  }

  return { name, type, readonly, description };
}

function resolveType(type: ts.Type, checker: ts.TypeChecker, depth: number): SdkType {
  if (depth >= MAX_TYPE_DEPTH) {
    return { raw: checker.typeToString(type), kind: 'unknown' };
  }

  const raw = checker.typeToString(type);

  if (isPromiseType(type, checker)) {
    const typeArgs = (type as ts.TypeReference).typeArguments;
    if (typeArgs && typeArgs.length > 0) {
      return resolveType(typeArgs[0], checker, depth);
    }
  }

  if (type.flags & ts.TypeFlags.String || type.flags & ts.TypeFlags.StringLiteral) {
    return { raw: 'string', kind: 'primitive' };
  }
  if (type.flags & ts.TypeFlags.Number || type.flags & ts.TypeFlags.NumberLiteral) {
    return { raw: 'number', kind: 'primitive' };
  }
  if (type.flags & ts.TypeFlags.Boolean || type.flags & ts.TypeFlags.BooleanLiteral) {
    return { raw: 'boolean', kind: 'primitive' };
  }
  if (type.flags & ts.TypeFlags.Void) return { raw: 'void', kind: 'primitive' };
  if (type.flags & ts.TypeFlags.Null) return { raw: 'null', kind: 'primitive' };
  if (type.flags & ts.TypeFlags.Undefined) return { raw: 'undefined', kind: 'primitive' };
  if (type.flags & ts.TypeFlags.Any) return { raw: 'any', kind: 'unknown' };
  if (raw === 'Buffer') return { raw: 'Buffer', kind: 'primitive' };

  if (type.isUnion()) {
    const members = type.types;
    const allStringLiterals = members.every((m) => m.flags & ts.TypeFlags.StringLiteral);
    if (allStringLiterals) {
      const enumValues = members.map((m) => (m as ts.StringLiteralType).value);
      return { raw, kind: 'enum', enumValues };
    }

    const unionTypes = members.map((m) => resolveType(m, checker, depth + 1));
    return { raw, kind: 'union', unionTypes };
  }

  if (checker.isArrayType(type)) {
    const typeArgs = (type as ts.TypeReference).typeArguments;
    const elementType =
      typeArgs && typeArgs.length > 0
        ? resolveType(typeArgs[0], checker, depth + 1)
        : ({ raw: 'any', kind: 'unknown' } as SdkType);
    return { raw, kind: 'array', elementType };
  }

  const symbol = type.getSymbol();
  if (symbol && symbol.flags & ts.SymbolFlags.Class) {
    return { raw, kind: 'class_reference', className: symbol.getName() };
  }

  const callSigs = type.getCallSignatures();
  if (callSigs.length > 0 && !hasNonMethodProperties(type)) {
    return { raw, kind: 'function' };
  }

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

      if (propCallSigs.length > 0 && !hasNonMethodProperties(propType)) {
        sdkMethods.push(extractMethodFromSignature(propName, propCallSigs[0], checker, prop));
      } else {
        const resolved = resolveType(propType, checker, depth + 1);
        const desc = getJsDocDescription(prop);
        const isReadonly =
          propDecl &&
          ts.isPropertySignature(propDecl) &&
          !!propDecl.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword);

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
