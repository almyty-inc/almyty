/**
 * An organization with its PII filter on, for specs that check what is
 * hidden: the production ToolExecutorService.hidePersonalData, run over a
 * plugin manager that has only the built-in PII filter active, with its
 * shipped settings. The detector is the product's own; nothing is faked
 * but the plugin registry.
 *
 * Not a `.spec.ts`, deliberately: jest collects `.*\.spec\.ts$`.
 */
import { PiiFilterPlugin } from '../../plugins/built-in/pii-filter.plugin';
import { ToolExecutorService } from '../../tools/tool-executor.service';

export function piiFilterOn(): (data: any, options: { organizationId: string; userId?: string }) => Promise<any> {
  const plugin = new PiiFilterPlugin();
  const settings = plugin.getPluginDefinition().configuration.settings;
  const pluginManager = {
    executeHook: async (_hook: any, context: any) => {
      const result = await plugin.filterPiiFromData(context, settings);
      return result.success ? { ...context, data: result.data } : context;
    },
  };
  const executor = { pluginManager, logger: { warn: () => undefined } };
  return (data, options) => (ToolExecutorService.prototype.hidePersonalData as any).call(executor, data, options);
}
