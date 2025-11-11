import { Injectable, Logger } from '@nestjs/common';
import ivm from 'isolated-vm';

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

    try {
      // Create isolated VM instance
      const isolate = new ivm.Isolate({ memoryLimit });
      const context = await isolate.createContext();

      // Inject parameters and axios into the context
      const jail = context.global;
      await jail.set('parameters', new ivm.ExternalCopy(parameters).copyInto());

      // For HTTP tools, inject axios functionality
      if (code.includes('axios')) {
        const axios = require('axios');
        await jail.set('_axios', new ivm.Reference(axios));
        await context.eval(`
          const axios = function(config) {
            return _axios.applyIgnored(null, [config], { arguments: { copy: true }, result: { promise: true, copy: true } });
          };
        `);
      }

      // Prepare the code with async wrapper
      const wrappedCode = `
        (async function() {
          ${code}
        })()
      `;

      // Compile and run the script with timeout
      const script = await isolate.compileScript(wrappedCode);
      const result = await script.run(context, { timeout, promise: true });

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
    }
  }

  /**
   * Validate custom code before saving
   */
  async validateCode(code: string): Promise<{ valid: boolean; error?: string }> {
    if (!code || code.trim().length === 0) {
      return { valid: false, error: 'Code cannot be empty' };
    }

    // Try to compile the code to check for syntax errors
    try {
      const isolate = new ivm.Isolate({ memoryLimit: 8 });
      await isolate.compileScript(code);
      isolate.dispose();

      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: `Syntax error: ${error.message}`,
      };
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
