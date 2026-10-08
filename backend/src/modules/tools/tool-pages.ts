import type { Tool } from '../../entities/tool.entity';
import type { ToolSearchFilters } from './dto/tools.dto';

/**
 * Every tool a ToolsService.getTools filter covers, not one page of it:
 * getTools 100 at a time, up to TOOL_SCOPE_MAX_TOOLS (default 5000). For
 * callers that rank or resolve over a whole scope (search_tools, get_tool,
 * prompts, code mode), where the first page alone would silently hide the
 * rest. The filter itself (team scope, private tools, status) is getTools's,
 * unchanged.
 */
export async function allPagesOfTools(
  source: { getTools(filters: ToolSearchFilters): Promise<{ tools: Tool[]; total?: number }> },
  filters: Omit<ToolSearchFilters, 'page' | 'limit'>,
  env: Record<string, string | undefined> = process.env,
): Promise<Tool[]> {
  const raw = Number(env.TOOL_SCOPE_MAX_TOOLS);
  const cap = Number.isInteger(raw) && raw > 0 ? raw : 5_000;
  const out: Tool[] = [];
  for (let page = 1; out.length < cap; page++) {
    const result = await source.getTools({ ...filters, page, limit: 100 });
    const tools = result?.tools ?? [];
    out.push(...tools);
    if (tools.length < 100 || (typeof result.total === 'number' && out.length >= result.total)) break;
  }
  return out.slice(0, cap);
}
