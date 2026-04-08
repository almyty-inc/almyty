import { PiiFilterPlugin } from './pii-filter.plugin';
import { PluginContext, PluginHookType } from '../types/plugin.types';

describe('PiiFilterPlugin - Real Business Logic', () => {
  let plugin: PiiFilterPlugin;
  let mockSettings: any;
  let mockContext: PluginContext;

  beforeEach(() => {
    plugin = new PiiFilterPlugin();

    mockSettings = {
      maskCharacter: '*',
      detectEmails: true,
      detectCreditCards: true,
      detectSSN: true,
      detectPhoneNumbers: true,
      detectIPAddresses: true,
      customPatterns: [],
      logDetections: true,
    };

    mockContext = {
      hookType: PluginHookType.PRE_REQUEST,
      userId: 'user-1',
      organizationId: 'org-1',
      requestId: 'req-1',
      data: {},
      metadata: {
        timestamp: new Date().toISOString(),
        plugin: {
          id: 'plugin-1',
          name: 'PII Filter',
          version: '1.0.0',
        },
        execution: {
          attempt: 1,
          timeout: 5000,
          startTime: Date.now(),
        },
      },
    };
  });

  describe('Plugin Definition', () => {
    it('should return plugin definition with correct metadata', () => {
      const definition = plugin.getPluginDefinition();

      expect(definition.name).toBe('PII Filter');
      expect(definition.version).toBe('1.0.0');
      expect(definition.isActive).toBe(true);
      expect(definition.configuration.priority).toBe(90); // High priority for security
    });

    it('should define correct hook types', () => {
      const definition = plugin.getPluginDefinition();

      expect(definition.capabilities.hooks).toContain(PluginHookType.PRE_REQUEST);
      expect(definition.capabilities.hooks).toContain(PluginHookType.POST_RESPONSE);
      expect(definition.capabilities.hooks).toContain(PluginHookType.DATA_FILTER);
    });

    it('should support multiple data formats', () => {
      const definition = plugin.getPluginDefinition();

      expect(definition.capabilities.dataFormats).toEqual(['json', 'xml', 'yaml']);
    });

    it('should define hooks with correct handlers', () => {
      const definition = plugin.getPluginDefinition();

      expect(definition.hooks).toHaveLength(3);
      expect(definition.hooks[0].handler).toBe('filterPiiFromRequest');
      expect(definition.hooks[1].handler).toBe('filterPiiFromResponse');
      expect(definition.hooks[2].handler).toBe('filterPiiFromData');
    });
  });

  describe('Credit Card Detection', () => {
    it('should detect and mask credit card numbers', async () => {
      const context = {
        ...mockContext,
        data: { message: 'My card is 4532-1234-5678-9010' },
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.data.message).not.toContain('4532-1234-5678-9010');
      expect(result.data.message).toContain('9010'); // Last 4 digits preserved
      expect(result.metadata.modifications.length).toBeGreaterThan(0);
    });

    it('should detect credit cards without dashes', async () => {
      const context = {
        ...mockContext,
        data: { cardNumber: '4532123456789010' },
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.data.cardNumber).not.toBe('4532123456789010');
      expect(result.metadata.modifications.length).toBeGreaterThan(0);
    });

    it('should detect credit cards with spaces', async () => {
      const context = {
        ...mockContext,
        data: { card: '4532 1234 5678 9010' },
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.data.card).not.toBe('4532 1234 5678 9010');
      expect(result.metadata.modifications.length).toBeGreaterThan(0);
    });
  });

  describe('SSN Detection', () => {
    it('should detect and mask SSN', async () => {
      const context = {
        ...mockContext,
        data: { ssn: '123-45-6789' },
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.data.ssn).not.toBe('123-45-6789');
      expect(result.data.ssn).toContain('6789'); // Last 4 preserved
      expect(result.metadata.modifications.length).toBeGreaterThan(0);
    });

    it('should log SSN detection', async () => {
      const context = {
        ...mockContext,
        data: { personal: { ssn: '987-65-4321' } },
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.metadata.logs).toHaveLength(1);
      expect(result.metadata.logs[0].level).toBe('info');
      expect(result.metadata.logs[0].message).toContain('Filtered');
    });
  });

  describe('Email Detection', () => {
    it('should detect and mask email addresses', async () => {
      const context = {
        ...mockContext,
        data: { contact: 'user@example.com' },
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.data.contact).not.toBe('user@example.com');
      expect(result.data.contact).toContain('.com'); // Domain TLD preserved
      expect(result.metadata.modifications.length).toBeGreaterThan(0);
    });

    it('should detect multiple email formats', async () => {
      const context = {
        ...mockContext,
        data: {
          email1: 'test@domain.com',
          email2: 'user.name+tag@company.co.uk',
          email3: 'simple@test.org',
        },
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.data.email1).not.toBe('test@domain.com');
      expect(result.data.email2).not.toBe('user.name+tag@company.co.uk');
      expect(result.data.email3).not.toBe('simple@test.org');
      expect(result.metadata.modifications.length).toBeGreaterThan(0);
    });
  });

  describe('Phone Number Detection', () => {
    it('should detect phone numbers with dashes', async () => {
      const context = {
        ...mockContext,
        data: { phone: '123-456-7890' },
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.data.phone).not.toBe('123-456-7890');
      expect(result.data.phone).toContain('7890'); // Last 4 preserved
      expect(result.metadata.modifications.length).toBeGreaterThan(0);
    });

    it('should detect phone numbers with dots', async () => {
      const context = {
        ...mockContext,
        data: { contact: '123.456.7890' },
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.data.contact).not.toBe('123.456.7890');
    });

    it('should detect phone numbers with spaces', async () => {
      const context = {
        ...mockContext,
        data: { mobile: '123 456 7890' },
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.data.mobile).not.toBe('123 456 7890');
    });
  });

  describe('IP Address Detection', () => {
    it('should detect and mask IP addresses', async () => {
      const context = {
        ...mockContext,
        data: { ip: '192.168.1.100' },
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.data.ip).not.toBe('192.168.1.100');
      expect(result.data.ip).toContain('.100'); // Last octet preserved
      expect(result.metadata.modifications.length).toBeGreaterThan(0);
    });

    it('should detect public IP addresses', async () => {
      const context = {
        ...mockContext,
        data: { server: '8.8.8.8' },
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.data.server).not.toBe('8.8.8.8');
    });
  });

  describe('Complex Object Filtering', () => {
    it('should filter PII from nested objects', async () => {
      const context = {
        ...mockContext,
        data: {
          user: {
            email: 'test@example.com',
            profile: {
              ssn: '123-45-6789',
              phone: '555-123-4567',
            },
          },
        },
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.data.user.email).not.toBe('test@example.com');
      expect(result.data.user.profile.ssn).not.toBe('123-45-6789');
      expect(result.data.user.profile.phone).not.toBe('555-123-4567');
      expect(result.metadata.modifications.length).toBeGreaterThan(0);
    });

    it('should filter PII from arrays', async () => {
      const context = {
        ...mockContext,
        data: {
          contacts: [
            { email: 'user1@test.com' },
            { email: 'user2@test.com' },
            { email: 'user3@test.com' },
          ],
        },
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.data.contacts[0].email).not.toBe('user1@test.com');
      expect(result.data.contacts[1].email).not.toBe('user2@test.com');
      expect(result.data.contacts[2].email).not.toBe('user3@test.com');
      expect(result.metadata.modifications.length).toBeGreaterThan(0);
    });

    it('should handle mixed data types', async () => {
      const context = {
        ...mockContext,
        data: {
          string: 'Contact me at test@example.com',
          number: 12345,
          boolean: true,
          null: null,
          undefined: undefined,
        },
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.data.string).not.toContain('test@example.com');
      expect(result.data.number).toBe(12345); // Non-PII unchanged
      expect(result.data.boolean).toBe(true);
      expect(result.data.null).toBe(null);
      expect(result.data.undefined).toBe(undefined);
    });
  });

  describe('Custom Patterns', () => {
    it('should apply custom PII patterns', async () => {
      const settingsWithCustom = {
        ...mockSettings,
        customPatterns: ['\\bACCT-\\d{6}\\b'], // Custom account number pattern
      };

      const context = {
        ...mockContext,
        data: { account: 'ACCT-123456' },
      };

      const result = await plugin.filterPiiFromRequest(context, settingsWithCustom);

      expect(result.success).toBe(true);
      expect(result.data.account).not.toBe('ACCT-123456');
      expect(result.metadata.modifications.length).toBeGreaterThan(0);
    });

    it('should handle invalid custom regex patterns gracefully', async () => {
      const settingsWithInvalid = {
        ...mockSettings,
        customPatterns: ['[invalid(regex'], // Invalid regex
      };

      const context = {
        ...mockContext,
        data: { test: 'some data' },
      };

      const result = await plugin.filterPiiFromRequest(context, settingsWithInvalid);

      expect(result.success).toBe(true); // Should not fail on invalid regex
      expect(result.data.test).toBe('some data'); // Data unchanged
    });

    it('should apply multiple custom patterns', async () => {
      const settingsWithMultiple = {
        ...mockSettings,
        customPatterns: ['\\bID-\\d{4}\\b', '\\bREF-[A-Z]{3}\\d{3}\\b'],
      };

      const context = {
        ...mockContext,
        data: {
          identifier: 'ID-1234',
          reference: 'REF-ABC123',
        },
      };

      const result = await plugin.filterPiiFromRequest(context, settingsWithMultiple);

      expect(result.success).toBe(true);
      expect(result.data.identifier).not.toBe('ID-1234');
      expect(result.data.reference).not.toBe('REF-ABC123');
    });
  });

  describe('Filter Variants - Request/Response/Data', () => {
    it('should filter PII from response', async () => {
      const context = {
        ...mockContext,
        data: { email: 'response@test.com' },
      };

      const result = await plugin.filterPiiFromResponse(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.data.email).not.toBe('response@test.com');
    });

    it('should filter PII from generic data', async () => {
      const context = {
        ...mockContext,
        data: { ssn: '111-22-3333' },
      };

      const result = await plugin.filterPiiFromData(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.data.ssn).not.toBe('111-22-3333');
    });
  });

  describe('Logging and Metadata', () => {
    it('should log when PII is detected', async () => {
      const context = {
        ...mockContext,
        data: { email: 'test@example.com' },
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.metadata.logs.length).toBeGreaterThan(0);
      expect(result.metadata.logs[0].message).toContain('Filtered');
      expect(result.metadata.logs[0].message).toContain('PII instances');
    });

    it('should not log when no PII is detected', async () => {
      const context = {
        ...mockContext,
        data: { message: 'No PII here' },
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.metadata.logs).toHaveLength(0);
      expect(result.metadata.modifications).toHaveLength(0);
    });

    it('should track execution time', async () => {
      const context = {
        ...mockContext,
        data: { large: 'test@example.com'.repeat(100) },
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.metadata.executionTime).toBeGreaterThanOrEqual(0);
    });

    it('should track modifications', async () => {
      const context = {
        ...mockContext,
        data: {
          email: 'test@example.com',
          ssn: '123-45-6789',
          phone: '555-1234',
        },
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.metadata.modifications.length).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    it('should not infinite-loop on a circular reference', async () => {
      // Previously this test pinned the OLD broken behaviour (error out
      // with PII_FILTER_ERROR on any self-referential graph). The walker
      // now has a WeakSet-based cycle guard, so the scan succeeds and
      // the same node is visited at most once.
      const circularData: any = { name: 'jane@example.com' };
      circularData.self = circularData;

      const context = {
        ...mockContext,
        data: circularData,
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      // The email at the top level should still be masked
      expect(result.data.name).not.toContain('jane@example.com');
      // And the self-reference should still be present (pointing at the
      // filtered parent, not the original).
      expect(result.data.self).toBeDefined();
    });

    it('should preserve data on error', async () => {
      // Pass null settings to trigger error
      const context = {
        ...mockContext,
        data: { important: 'data' },
      };

      const result = await plugin.filterPiiFromRequest(context, null);

      expect(result.success).toBe(false);
      expect(result.data).toEqual({ important: 'data' });
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty data', async () => {
      const context = {
        ...mockContext,
        data: {},
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({});
    });

    it('should handle null data', async () => {
      const context = {
        ...mockContext,
        data: null,
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.data).toBe(null);
    });

    it('should handle string data directly', async () => {
      const context = {
        ...mockContext,
        data: 'My email is test@example.com',
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.data).not.toContain('test@example.com');
    });

    it('should handle array data directly', async () => {
      const context = {
        ...mockContext,
        data: ['test@example.com', '555-123-4567', 'normal text'],
      };

      const result = await plugin.filterPiiFromRequest(context, mockSettings);

      expect(result.success).toBe(true);
      expect(result.data[0]).not.toBe('test@example.com');
      expect(result.data[1]).not.toBe('555-123-4567');
      expect(result.data[2]).toBe('normal text');
    });
  });

  // ── Regression: feature toggles were documented but dead code ──────
  describe('Feature toggles (regression)', () => {
    it('detectEmails: false leaves emails untouched', async () => {
      const settings = { ...mockSettings, detectEmails: false };
      const ctx = { ...mockContext, data: 'contact jane@example.com please' };

      const result = await plugin.filterPiiFromRequest(ctx, settings);
      expect(result.success).toBe(true);
      expect(result.data).toBe('contact jane@example.com please');
    });

    it('detectCreditCards: false leaves 16-digit numbers untouched', async () => {
      const settings = { ...mockSettings, detectCreditCards: false };
      const ctx = { ...mockContext, data: 'card: 4111 1111 1111 1111' };

      const result = await plugin.filterPiiFromRequest(ctx, settings);
      expect(result.data).toBe('card: 4111 1111 1111 1111');
    });

    it('detectSSN: false leaves SSN patterns untouched', async () => {
      const settings = { ...mockSettings, detectSSN: false };
      const ctx = { ...mockContext, data: 'id 123-45-6789' };

      const result = await plugin.filterPiiFromRequest(ctx, settings);
      expect(result.data).toBe('id 123-45-6789');
    });

    it('detectPhoneNumbers: false leaves phone patterns untouched', async () => {
      const settings = { ...mockSettings, detectPhoneNumbers: false };
      const ctx = { ...mockContext, data: 'call 555-123-4567' };

      const result = await plugin.filterPiiFromRequest(ctx, settings);
      expect(result.data).toBe('call 555-123-4567');
    });

    it('detectIPAddresses: false leaves IP patterns untouched', async () => {
      const settings = { ...mockSettings, detectIPAddresses: false };
      const ctx = { ...mockContext, data: 'host 10.20.30.40' };

      const result = await plugin.filterPiiFromRequest(ctx, settings);
      expect(result.data).toBe('host 10.20.30.40');
    });

    it('still masks categories that ARE enabled even when others are off', async () => {
      const settings = {
        ...mockSettings,
        detectEmails: false,
        detectCreditCards: true,
      };
      const ctx = {
        ...mockContext,
        data: 'email jane@example.com and card 4111 1111 1111 1111',
      };

      const result = await plugin.filterPiiFromRequest(ctx, settings);
      expect(result.data).toContain('jane@example.com');        // email left alone
      expect(result.data).not.toContain('4111 1111 1111 1111'); // card still masked
    });

    it('logDetections: false drops the per-match breadcrumbs', async () => {
      const settings = { ...mockSettings, logDetections: false };
      const ctx = { ...mockContext, data: 'email jane@example.com' };

      const result = await plugin.filterPiiFromRequest(ctx, settings);
      expect(result.success).toBe(true);
      expect(result.metadata.modifications).toEqual([]);
      expect(result.metadata.logs).toEqual([]);
      // The actual masking still happens — logDetections only suppresses
      // the reporting, not the filtering.
      expect(result.data).not.toContain('jane@example.com');
    });
  });

  // ── Regression: custom pattern ReDoS budget ─────────────────────────
  describe('Custom pattern ReDoS budget (regression)', () => {
    it('abandons the remaining custom patterns after one overruns the budget', async () => {
      // Structural check rather than a timing check — asserting on
      // wall-clock elapsed is flaky under load. The invariant we care
      // about is: if the FIRST custom pattern overruns the per-pattern
      // budget, the SECOND one never runs. We prove that by giving the
      // second pattern a distinctive target substring and confirming
      // it survives the scan unmasked.
      //
      // The evil regex is classic catastrophic backtracking on ~20
      // `a`s. One match takes tens-to-hundreds of milliseconds —
      // enough to trip the 50ms budget but bounded enough to finish.
      const input = 'a'.repeat(22) + '!SECOND_PATTERN_TARGET';
      const settings = {
        ...mockSettings,
        customPatterns: [
          '(a+)+$',                // evil, runs first, overruns budget
          'SECOND_PATTERN_TARGET', // normal, would mask the target
        ],
      };
      const ctx = { ...mockContext, data: input };

      const result = await plugin.filterPiiFromRequest(ctx, settings);

      expect(result.success).toBe(true);
      // If the budget bail worked, the second custom pattern was never
      // applied and its target is still intact in the output. Pre-fix
      // both patterns ran regardless of cumulative cost.
      expect(result.data).toContain('SECOND_PATTERN_TARGET');
    });
  });

  // ── Regression: bounded recursion + modifications array ────────────
  describe('Walker bounds (regression)', () => {
    it('bounds the modifications array to MAX_MODIFICATIONS entries', async () => {
      // Build a wide object with more than MAX_MODIFICATIONS fields,
      // each containing an email — and make sure the reporter doesn't
      // grow unbounded.
      const wide: any = {};
      for (let i = 0; i < 700; i++) {
        wide[`field_${i}`] = `user${i}@example.com`;
      }
      const ctx = { ...mockContext, data: wide };

      const result = await plugin.filterPiiFromRequest(ctx, mockSettings);
      expect(result.success).toBe(true);
      // Modifications are capped; the exact cap is an implementation detail
      // but it must be well below the field count.
      expect(result.metadata.modifications.length).toBeLessThanOrEqual(500);
    });
  });
});
