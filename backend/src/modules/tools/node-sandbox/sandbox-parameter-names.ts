/**
 * How a JavaScript tool's code reads its inputs.
 *
 * Create tool says code reads a parameter as `params.name` or directly
 * as `name` (tool-form.tsx). The sandbox therefore binds `parameters`
 * and `params` (the same object) and, for each parameter whose name can
 * be a variable, that name to its value.
 *
 * A bare name is only ever a local of the tool's own function, so it can
 * shadow a global (`process`, `fetch`) for that code alone and changes
 * nothing outside it. What it must not do is replace one of the sandbox's
 * own bindings: a parameter named `require` would otherwise stand in for
 * the allowlisted require, and `tools` for the nested-invocation bridge.
 * Those names, reserved words (which would not compile) and names strict
 * code may not bind are left out; such a parameter is still read through
 * `parameters` / `params`.
 */

/** The sandbox's own bindings, in the order the function takes them. */
export const SANDBOX_BINDINGS = ['parameters', 'params', 'credentials', 'require', 'tools'] as const;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const NOT_BINDABLE = new Set<string>([
  // Reserved words
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with',
  // Not bindable in an async function, or in strict code
  'await', 'yield', 'let', 'static', 'implements', 'interface', 'package', 'private',
  'protected', 'public', 'eval', 'arguments',
  // The sandbox's own
  ...SANDBOX_BINDINGS,
]);

/** The parameter names bound as bare variables, in a stable order. */
export function bareParameterNames(parameters: unknown): string[] {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return [];
  return Object.keys(parameters).filter((name) => IDENTIFIER.test(name) && !NOT_BINDABLE.has(name));
}
