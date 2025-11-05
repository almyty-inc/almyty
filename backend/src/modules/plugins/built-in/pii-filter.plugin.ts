import {
  Plugin,
  PluginHookType,
  PluginContext,
  PluginResult,
} from '../types/plugin.types';

export class PiiFilterPlugin {
  private readonly piiPatterns = [
    /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, // Credit card numbers
    /\b\d{3}-\d{2}-\d{4}\b/g, // SSN format
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, // Email addresses
    /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, // Phone numbers
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, // IP addresses
  ];

  getPluginDefinition(): Omit<Plugin, 'id' | 'metadata'> {
    return {
      name: 'PII Filter',
      version: '1.0.0',
      description: 'Automatically detects and filters personally identifiable information (PII) from requests and responses',
      author: 'apifai',
      isActive: true,
      configuration: {
        enabled: true,
        priority: 90, // High priority for security
        settings: {
          maskCharacter: '*',
          detectEmails: true,
          detectCreditCards: true,
          detectSSN: true,
          detectPhoneNumbers: true,
          detectIPAddresses: true,
          customPatterns: [],
          logDetections: true,
        },
      },
      capabilities: {
        hooks: [
          PluginHookType.PRE_REQUEST,
          PluginHookType.POST_RESPONSE,
          PluginHookType.PRE_TOOL_EXECUTION,
          PluginHookType.DATA_FILTER,
        ],
        protocols: ['mcp', 'utcp', 'a2a', 'http'],
        dataFormats: ['json', 'xml', 'yaml'],
        operations: ['read', 'transform'],
      },
      hooks: [
        {
          type: PluginHookType.PRE_REQUEST,
          handler: 'filterPiiFromRequest',
          async: false,
          timeout: 5000,
        },
        {
          type: PluginHookType.POST_RESPONSE,
          handler: 'filterPiiFromResponse',
          async: false,
          timeout: 5000,
        },
        {
          type: PluginHookType.DATA_FILTER,
          handler: 'filterPiiFromData',
          async: false,
          timeout: 5000,
        },
      ],
    };
  }

  async filterPiiFromRequest(context: PluginContext, settings: any): Promise<PluginResult> {
    const startTime = Date.now();
    const modifications: string[] = [];

    try {
      const filteredData = this.filterPiiFromObject(context.data, settings, modifications);
      
      return {
        success: true,
        data: filteredData,
        metadata: {
          executionTime: Date.now() - startTime,
          modifications,
          logs: modifications.length > 0 ? [
            {
              level: 'info',
              message: `Filtered ${modifications.length} PII instances from request`,
              timestamp: new Date().toISOString(),
            },
          ] : [],
        },
      };

    } catch (error) {
      return {
        success: false,
        data: context.data,
        error: {
          code: 'PII_FILTER_ERROR',
          message: error.message,
        },
        metadata: {
          executionTime: Date.now() - startTime,
          modifications: [],
        },
      };
    }
  }

  async filterPiiFromResponse(context: PluginContext, settings: any): Promise<PluginResult> {
    return this.filterPiiFromRequest(context, settings); // Same logic
  }

  async filterPiiFromData(context: PluginContext, settings: any): Promise<PluginResult> {
    return this.filterPiiFromRequest(context, settings); // Same logic
  }

  private filterPiiFromObject(obj: any, settings: any, modifications: string[]): any {
    if (typeof obj === 'string') {
      return this.filterPiiFromString(obj, settings, modifications);
    }

    if (Array.isArray(obj)) {
      return obj.map((item, index) => {
        const filtered = this.filterPiiFromObject(item, settings, modifications);
        if (filtered !== item) {
          modifications.push(`array[${index}]`);
        }
        return filtered;
      });
    }

    if (obj && typeof obj === 'object') {
      const filtered: any = {};
      
      for (const [key, value] of Object.entries(obj)) {
        const filteredValue = this.filterPiiFromObject(value, settings, modifications);
        if (filteredValue !== value) {
          modifications.push(key);
        }
        filtered[key] = filteredValue;
      }
      
      return filtered;
    }

    return obj;
  }

  private filterPiiFromString(text: string, settings: any, modifications: string[]): string {
    let filteredText = text;
    const maskChar = settings.maskCharacter || '*';

    for (const pattern of this.piiPatterns) {
      const matches = filteredText.match(pattern);
      if (matches) {
        for (const match of matches) {
          const masked = maskChar.repeat(Math.max(4, match.length - 4)) + match.slice(-4);
          filteredText = filteredText.replace(match, masked);
          modifications.push(`PII detected and masked: ${match.slice(0, 2)}...`);
        }
      }
    }

    // Apply custom patterns
    if (settings.customPatterns) {
      for (const customPattern of settings.customPatterns) {
        try {
          const regex = new RegExp(customPattern, 'g');
          const matches = filteredText.match(regex);
          if (matches) {
            for (const match of matches) {
              const masked = maskChar.repeat(match.length);
              filteredText = filteredText.replace(match, masked);
              modifications.push(`Custom PII pattern matched: ${customPattern}`);
            }
          }
        } catch (error) {
          // Invalid regex pattern - skip
        }
      }
    }

    return filteredText;
  }
}