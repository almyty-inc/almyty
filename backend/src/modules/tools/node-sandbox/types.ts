/**
 * Node.js Worker Thread Sandbox — shared type definitions
 */

/** Request to execute code in the sandbox */
export interface SandboxExecutionRequest {
  /** JavaScript/TypeScript code to execute (function body) */
  code: string;
  /** Parameters passed into the function */
  parameters: Record<string, any>;
  /** Credentials available inside the sandbox */
  credentials?: Record<string, string>;
  /** npm dependencies required (name -> version) */
  dependencies?: Record<string, string>;
  /** Maximum execution time in ms (default 10 000) */
  timeoutMs?: number;
  /** Maximum heap memory in MB (default 128) */
  memoryLimitMb?: number;
  /** Optional npm registry config for private packages */
  npmRegistry?: NpmRegistryConfig;
  /**
   * Cooperative cancellation — if provided, aborting this signal
   * terminates the worker and returns a cancelled result.
   */
  signal?: AbortSignal;
  /**
   * Host-side callback for tool invocation from inside the
   * sandbox. When the user code calls the injected
   * `tools.invoke(toolId, params)` global, the worker posts a
   * message to the host and the host calls this function to run
   * the nested tool in its own fresh sandbox with the same
   * tenant context. If omitted, `tools.invoke` is not available
   * inside the sandbox at all.
   */
  invokeTool?: (
    toolId: string,
    params: Record<string, any>,
    signal?: AbortSignal,
  ) => Promise<any>;
  /**
   * Extra `--allow-fs-read=<path>` entries for the worker's
   * permission model. Used by integration tests to tighten or
   * widen the allowed read set. In production, the set is
   * computed from the dep install dir + the worker script dir
   * and this field should stay unset.
   */
  extraAllowReads?: string[];
  /**
   * Test-only network allow list forwarded to the sandbox
   * net-guard. Comma-separated `host:port` entries that bypass
   * the SSRF ban list so integration tests can stand up a local
   * HTTP server on 127.0.0.1 and exercise the worker against it.
   * Production callers never set this.
   */
  testNetAllow?: string;
}

/** Result returned after sandbox execution */
export interface SandboxExecutionResult {
  success: boolean;
  data?: any;
  error?: string;
  executionTimeMs: number;
  /** True when the worker was killed for exceeding the memory limit */
  oom?: boolean;
}

/** Passed to the worker thread via workerData */
export interface WorkerInput {
  code: string;
  parameters: Record<string, any>;
  credentials: Record<string, string>;
  /** Absolute paths to node_modules directories the worker may require from */
  modulePaths: string[];
  /**
   * True when the host wired up a tools.invoke callback. The
   * worker bootstrap uses this to decide whether to inject the
   * `tools` global — if the host can't service the invocation,
   * we'd rather the global be undefined and user code fail with
   * `ReferenceError: tools is not defined` than have it hang
   * waiting for a response that never comes.
   */
  toolInvokeEnabled: boolean;
  /**
   * Test-only network allow list, forwarded to the sandbox
   * net-guard. Comma-separated `host:port` entries that bypass
   * the SSRF ban list so integration tests can stand up a local
   * HTTP server on 127.0.0.1 and exercise the worker against it.
   * Production callers never set this.
   */
  testNetAllow?: string;
}

/** Message sent from the worker back to the parent */
export interface WorkerOutput {
  success: boolean;
  data?: any;
  error?: string;
}

/** Configuration for a private npm registry */
export interface NpmRegistryConfig {
  url: string;
  authToken?: string;
  scope?: string;
}

/** Result of installing dependencies */
export interface DependencyInstallResult {
  /** Absolute path to the directory containing node_modules */
  installDir: string;
  /** Whether the install was a cache hit */
  cached: boolean;
  /** Time the installation took in ms (0 on cache hit) */
  installTimeMs: number;
}

/** Map of SDK package name to its introspected exports */
export type SdkMap = Record<string, SdkExport>;

/** Introspected export of a single SDK package */
export interface SdkExport {
  /** The default or named export identifier */
  name: string;
  /** Constructor parameters (only when isClass is true) */
  constructorParams: SdkParam[];
  /** Methods discovered on the export */
  methods: SdkMethod[];
  /** Properties discovered on the export */
  properties: SdkProperty[];
  /** True if the export is a class (has a constructor) */
  isClass: boolean;
  /** True if the export is a function (standalone) */
  isFunction: boolean;
  /** JSDoc description of the export */
  description?: string;
}

/** A method discovered on an SDK export */
export interface SdkMethod {
  name: string;
  params: SdkParam[];
  returnType: SdkType;
  isAsync: boolean;
  isStatic: boolean;
  description?: string;
}

/** A property discovered on an SDK export */
export interface SdkProperty {
  name: string;
  type: SdkType;
  readonly: boolean;
  description?: string;
}

/** A parameter of an SDK method */
export interface SdkParam {
  name: string;
  type: SdkType;
  optional: boolean;
  defaultValue?: string;
}

/** Simplified type representation */
export interface SdkType {
  raw: string;
  kind:
    | 'primitive'
    | 'object'
    | 'array'
    | 'function'
    | 'union'
    | 'enum'
    | 'class_reference'
    | 'unknown';
  /** For 'object' kind: nested properties */
  properties?: SdkProperty[];
  /** For 'array' kind: element type */
  elementType?: SdkType;
  /** For 'union' kind: constituent types */
  unionTypes?: SdkType[];
  /** For 'enum' kind: allowed string literal values */
  enumValues?: string[];
  /** For 'class_reference' kind: the class name */
  className?: string;
  /** For 'object' kind with methods (chained API sub-objects) */
  methods?: SdkMethod[];
}

// ---------------------------------------------------------------------------
// SDK Code Assembler types
// ---------------------------------------------------------------------------

/** Full SDK configuration for code assembly */
export interface SdkConfig {
  /** Package name, e.g. "@aws-sdk/client-s3" */
  packageName: string;
  /** Version constraint */
  version: string;
  /** Imports to pull from the package */
  imports: SdkImport[];
  /** Client / class to construct, if any */
  construct?: SdkConstruct;
  /** Method call to execute */
  call: SdkCall;
}

/** An import from the package */
export interface SdkImport {
  /** The export name */
  name: string;
  /** True if this is the default export */
  isDefault: boolean;
}

/** How to construct a client */
export interface SdkConstruct {
  /** Class name to instantiate */
  className: string;
  /** Arguments to pass to the constructor */
  args: SdkValue[];
}

/** A method call on the constructed client (or standalone function call) */
export interface SdkCall {
  /** Dot-separated chain path, e.g. "customers.create" or just "send" */
  methodPath: string;
  /** Arguments to the method */
  args: SdkValue[];
}

/**
 * A value used in constructor args, method args, or nested objects.
 * Discriminated on `type`.
 */
export type SdkValue =
  | SdkLiteralValue
  | SdkParameterRef
  | SdkCredentialRef
  | SdkObjectValue
  | SdkArrayValue
  | SdkClassInstanceValue;

export interface SdkLiteralValue {
  type: 'literal';
  value: string | number | boolean | null;
}

export interface SdkParameterRef {
  type: 'parameter';
  /** Key in the parameters map */
  key: string;
}

export interface SdkCredentialRef {
  type: 'credential';
  /** Key in the credentials map */
  key: string;
}

export interface SdkObjectValue {
  type: 'object';
  properties: Record<string, SdkValue>;
}

export interface SdkArrayValue {
  type: 'array';
  items: SdkValue[];
}

export interface SdkClassInstanceValue {
  type: 'class_instance';
  className: string;
  args: SdkValue[];
}

/** @deprecated Use SdkImport/SdkValue instead */
export interface SdkConfigValue {
  key: string;
  value: string;
  /** If true, the value comes from credentials */
  fromCredential: boolean;
}
