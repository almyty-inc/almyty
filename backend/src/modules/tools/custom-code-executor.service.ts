import { Injectable, Logger } from '@nestjs/common';
import * as ivm from 'isolated-vm';
import { validateUrl } from '../../common/security/url-validator';

export interface CustomCodeExecutionResult {
  success: boolean;
  data?: any;
  error?: string;
  executionTime: number;
}

@Injectable()
export class CustomCodeExecutorService {
  private readonly logger = new Logger(CustomCodeExecutorService.name);
  private readonly DEFAULT_TIMEOUT = 5000; // 5 seconds
  private readonly MEMORY_LIMIT = 128; // 128 MB

  /**
   * Execute custom JavaScript code in a secure isolated environment
   */
  async executeCode(
    code: string,
    parameters: Record<string, any>,
    options?: {
      timeout?: number;
      memoryLimit?: number;
    }
  ): Promise<CustomCodeExecutionResult> {
    const startTime = Date.now();
    const timeout = options?.timeout || this.DEFAULT_TIMEOUT;
    const memoryLimit = options?.memoryLimit || this.MEMORY_LIMIT;

    // Declared outside try so the finally block can always dispose. Without
    // this, every tool execution leaked an isolated-vm Isolate — the native
    // V8 heap was never reclaimed until the process restarted.
    let isolate: ivm.Isolate | null = null;

    try {
      // Create isolated VM instance
      isolate = new ivm.Isolate({ memoryLimit });
      const context = await isolate.createContext();

      // Inject parameters as individual variables AND as parameters object
      const jail = context.global;

      // Set parameters object (and 'params' alias)
      await jail.set('parameters', new ivm.ExternalCopy(parameters).copyInto());
      await jail.set('params', new ivm.ExternalCopy(parameters).copyInto());

      // Also set each parameter as individual variable
      for (const [key, value] of Object.entries(parameters)) {
        await jail.set(key, new ivm.ExternalCopy(value).copyInto());
      }

      // Inject safe HTTP client with SSRF protection
      if (code.includes('axios') || code.includes('fetch') || code.includes('http')) {
        const axios = require('axios');
        const safeRequest = async (config: any) => {
          // Validate URL before allowing request
          const url = typeof config === 'string' ? config : config?.url;
          if (!url) throw new Error('URL is required');

          const urlCheck = validateUrl(url);
          if (!urlCheck.valid) {
            throw new Error(`Blocked by SSRF protection: ${urlCheck.error}`);
          }

          // Enforce timeout and response size limits
          const safeConfig = typeof config === 'string' ? { url: config } : { ...config };
          safeConfig.timeout = Math.min(safeConfig.timeout || 10000, 30000); // Max 30s
          safeConfig.maxContentLength = 5 * 1024 * 1024; // 5MB max
          safeConfig.maxBodyLength = 1 * 1024 * 1024; // 1MB max body

          const response = await axios(safeConfig);
          return { status: response.status, data: response.data, headers: response.headers };
        };

        await jail.set('_safeRequest', new ivm.Reference(safeRequest));
        await context.eval(`
          const axios = function(config) {
            return _safeRequest.apply(undefined, [config], { arguments: { copy: true }, result: { promise: true, copy: true } });
          };
          axios.get = function(url, config) {
            return axios({ ...config, url, method: 'GET' });
          };
          axios.post = function(url, data, config) {
            return axios({ ...config, url, method: 'POST', data });
          };
          axios.put = function(url, data, config) {
            return axios({ ...config, url, method: 'PUT', data });
          };
          axios.delete = function(url, config) {
            return axios({ ...config, url, method: 'DELETE' });
          };
        `);
      }

      if (code.includes('soap')) {
        // SOAP client with URL validation
        const soap = require('soap');
        const safeSoapCreate = async (url: string) => {
          const urlCheck = validateUrl(url);
          if (!urlCheck.valid) {
            throw new Error(`Blocked by SSRF protection: ${urlCheck.error}`);
          }
          return soap.createClientAsync(url);
        };
        await jail.set('_safeSoapCreate', new ivm.Reference(safeSoapCreate));
        await context.eval(`
          const soap = {
            createClientAsync: function(url) {
              return _safeSoapCreate.apply(undefined, [url], { arguments: { copy: true }, result: { promise: true, copy: true } });
            }
          };
        `);
      }

      // Prepare the code with async wrapper that JSON-serializes the result
      // to avoid "A non-transferable value was passed" errors when crossing
      // the isolate boundary. All return values must be JSON-serializable.
      const wrappedCode = `
        (async function() {
          const __userResult = await (async function() {
            ${code}
          })();
          return JSON.stringify(__userResult === undefined ? null : __userResult);
        })()
      `;

      // Compile and run the script with timeout
      const script = await isolate.compileScript(wrappedCode);
      const rawResult = await script.run(context, { timeout, promise: true });
      const result = rawResult ? JSON.parse(rawResult) : null;

      const executionTime = Date.now() - startTime;

      this.logger.log(`Custom code executed successfully in ${executionTime}ms`);

      return {
        success: true,
        data: result,
        executionTime,
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;

      this.logger.error(`Custom code execution failed: ${error.message}`);

      return {
        success: false,
        error: error.message || 'Code execution failed',
        executionTime,
      };
    } finally {
      if (isolate && !isolate.isDisposed) {
        try {
          isolate.dispose();
        } catch (disposeErr) {
          this.logger.warn(`Isolate dispose failed: ${(disposeErr as Error).message}`);
        }
      }
    }
  }

  /**
   * Validate custom code before saving
   */
  async validateCode(code: string): Promise<{ valid: boolean; error?: string; warnings?: string[] }> {
    if (!code || code.trim().length === 0) {
      return { valid: false, error: 'Code cannot be empty' };
    }

    // Check for dangerous patterns
    const warnings: string[] = [];
    const DANGEROUS_PATTERNS = [
      { pattern: /process\.exit/i, msg: 'process.exit is not allowed' },
      { pattern: /child_process/i, msg: 'child_process module is not allowed' },
      { pattern: /require\s*\(\s*['"]fs['"]\s*\)/i, msg: 'fs module is not allowed' },
      { pattern: /require\s*\(\s*['"]net['"]\s*\)/i, msg: 'net module is not allowed' },
      { pattern: /require\s*\(\s*['"]dgram['"]\s*\)/i, msg: 'dgram module is not allowed' },
      { pattern: /eval\s*\(/i, msg: 'eval() usage detected — may be unsafe' },
      { pattern: /Function\s*\(/i, msg: 'Function constructor detected — may be unsafe' },
    ];

    for (const { pattern, msg } of DANGEROUS_PATTERNS) {
      if (pattern.test(code)) {
        warnings.push(msg);
      }
    }

    // Try to compile the code to check for syntax errors.
    // Previously the isolate leaked on compile failure because dispose()
    // was only reached on the happy path.
    let validateIsolate: ivm.Isolate | null = null;
    try {
      validateIsolate = new ivm.Isolate({ memoryLimit: 8 });
      await validateIsolate.compileScript(code);
      return { valid: true, warnings: warnings.length > 0 ? warnings : undefined };
    } catch (error) {
      return {
        valid: false,
        error: `Syntax error: ${error.message}`,
      };
    } finally {
      if (validateIsolate && !validateIsolate.isDisposed) {
        try {
          validateIsolate.dispose();
        } catch {
          // swallow — nothing useful we can do here
        }
      }
    }
  }

  /**
   * Get safe execution environment info
   */
  getExecutionLimits() {
    return {
      timeout: this.DEFAULT_TIMEOUT,
      memoryLimit: this.MEMORY_LIMIT,
      features: {
        networkAccess: false,
        fileSystemAccess: false,
        processAccess: false,
        modules: ['none'], // No require() allowed
      },
    };
  }
}
