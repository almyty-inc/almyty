import type {
  SdkExport,
  SdkMap,
  SdkMethod,
  SdkParam,
  SdkProperty,
  SdkType,
} from '../tools/node-sandbox/types';

/**
 * The shape `api.sdkMaps[packageName]` is stored in, and the shape the
 * Create tool form (`frontend/src/types/runtime.ts` SdkMap) reads.
 *
 * The introspector returns its own TypeScript-checker shape
 * (`node-sandbox/types.ts` SdkMap: export name -> SdkExport with
 * isClass / isFunction / optional). This module is the one place the
 * two meet, so the form never has to know the checker's vocabulary.
 */
export interface SdkPackageMap {
  packageName: string;
  version: string;
  exports: SdkPackageExport[];
}

export type SdkPackageExportKind = 'class' | 'function' | 'const' | 'namespace';

export interface SdkPackageExport {
  name: string;
  kind: SdkPackageExportKind;
  description?: string;
  constructorParams?: SdkPackageParam[];
  methods?: SdkPackageMethod[];
  properties?: SdkPackageProperty[];
  params?: SdkPackageParam[];
}

export interface SdkPackageMethod {
  name: string;
  description?: string;
  params: SdkPackageParam[];
  returnType?: SdkPackageType;
  isAsync: boolean;
}

export interface SdkPackageProperty {
  name: string;
  description?: string;
  type: SdkPackageType;
  methods?: SdkPackageMethod[];
  properties?: SdkPackageProperty[];
}

export interface SdkPackageParam {
  name: string;
  type: SdkPackageType;
  required: boolean;
  description?: string;
}

export interface SdkPackageType {
  kind:
    | 'string'
    | 'number'
    | 'boolean'
    | 'object'
    | 'array'
    | 'union'
    | 'enum'
    | 'class_ref'
    | 'function'
    | 'any'
    | 'void'
    | 'buffer';
  properties?: SdkPackageParam[];
  itemType?: SdkPackageType;
  enumValues?: string[];
  className?: string;
  rawType?: string;
}

/** Nested chains deeper than this are not offered (the form stops at three). */
const MAX_PROPERTY_DEPTH = 3;

export function toPackageType(t: SdkType | undefined, depth = 0): SdkPackageType {
  if (!t) return { kind: 'any' };
  const rawType = t.raw;
  switch (t.kind) {
    case 'primitive':
      if (t.raw === 'string' || t.raw === 'number' || t.raw === 'boolean') return { kind: t.raw, rawType };
      if (t.raw === 'Buffer') return { kind: 'buffer', rawType };
      if (t.raw === 'void' || t.raw === 'undefined' || t.raw === 'null') return { kind: 'void', rawType };
      return { kind: 'any', rawType };
    case 'array':
      return { kind: 'array', rawType, itemType: toPackageType(t.elementType, depth + 1) };
    case 'enum':
      return { kind: 'enum', rawType, enumValues: t.enumValues ?? [] };
    case 'union':
      return { kind: 'union', rawType };
    case 'class_reference':
      return { kind: 'class_ref', rawType, className: t.className };
    case 'function':
      return { kind: 'function', rawType };
    case 'object':
      return {
        kind: 'object',
        rawType,
        ...(t.properties && depth < MAX_PROPERTY_DEPTH
          ? {
              properties: t.properties.map((p) => ({
                name: p.name,
                type: toPackageType(p.type, depth + 1),
                // A property of an object type carries no optional flag in
                // the checker's output; the person decides what to fill.
                required: false,
                ...(p.description ? { description: p.description } : {}),
              })),
            }
          : {}),
      };
    default:
      return { kind: 'any', rawType };
  }
}

function toPackageParam(p: SdkParam): SdkPackageParam {
  return { name: p.name, type: toPackageType(p.type), required: !p.optional };
}

function toPackageMethod(m: SdkMethod): SdkPackageMethod {
  return {
    name: m.name,
    ...(m.description ? { description: m.description } : {}),
    params: (m.params ?? []).map(toPackageParam),
    returnType: toPackageType(m.returnType),
    isAsync: !!m.isAsync,
  };
}

/**
 * A property becomes a chain the form can call through
 * (`client.customers.create`) when its type carries methods.
 */
function toPackageProperty(p: SdkProperty, depth = 0): SdkPackageProperty {
  const t = p.type;
  const nestedMethods = t?.kind === 'object' && t.methods ? t.methods.map(toPackageMethod) : undefined;
  const nestedProps =
    t?.kind === 'object' && t.properties && depth < MAX_PROPERTY_DEPTH
      ? t.properties.map((sub) => toPackageProperty(sub, depth + 1))
      : undefined;
  return {
    name: p.name,
    ...(p.description ? { description: p.description } : {}),
    type: toPackageType(t),
    ...(nestedMethods?.length ? { methods: nestedMethods } : {}),
    ...(nestedProps?.length ? { properties: nestedProps } : {}),
  };
}

function exportKind(e: SdkExport): SdkPackageExportKind {
  if (e.isClass) return 'class';
  if (e.isFunction) return 'function';
  if ((e.methods?.length ?? 0) > 0 || (e.properties?.length ?? 0) > 0) return 'namespace';
  return 'const';
}

export function toPackageExport(e: SdkExport): SdkPackageExport {
  const kind = exportKind(e);
  const methods = (e.methods ?? []).map(toPackageMethod);
  return {
    name: e.name,
    kind,
    ...(e.description ? { description: e.description } : {}),
    constructorParams: (e.constructorParams ?? []).map(toPackageParam),
    methods,
    properties: (e.properties ?? []).map((p) => toPackageProperty(p)),
    // A function export is called directly: its own signature is the call.
    ...(kind === 'function' && methods[0] ? { params: methods[0].params } : {}),
  };
}

/** The introspector's map for one package, in the stored shape. */
export function toSdkPackageMap(packageName: string, version: string, map: SdkMap): SdkPackageMap {
  return {
    packageName,
    version,
    exports: Object.values(map).map(toPackageExport),
  };
}

/** How many callables a stored package map offers, chained ones included. */
export function countCallables(pkg: SdkPackageMap): number {
  const countProp = (p: SdkPackageProperty): number =>
    (p.methods?.length ?? 0) + (p.properties ?? []).reduce((n, sub) => n + countProp(sub), 0);
  return pkg.exports.reduce(
    (n, e) => n + (e.methods?.length ?? 0) + (e.properties ?? []).reduce((m, p) => m + countProp(p), 0),
    0,
  );
}
