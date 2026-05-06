import axios, { AxiosRequestConfig } from 'axios';
import {
  getByDotPath,
  assertSafeNextPageUrl,
  evaluateHttpSuccessCondition,
} from '../tool-execution-utils';

export function processHttpResponse(response: any, httpConfig: any): any {
  const mapping = httpConfig.responseMapping;
  let data = response.data;

  if (mapping?.successCondition) {
    const success = evaluateHttpSuccessCondition(
      mapping.successCondition,
      response.status,
      data,
    );
    if (!success) {
      const errorMsg = mapping.errorPath
        ? getByDotPath(data, mapping.errorPath)
        : 'Request failed';
      const err: any = new Error(String(errorMsg));
      err.response = response;
      err.isAxiosError = true;
      throw err;
    }
  }

  if (mapping?.dataPath) {
    data = getByDotPath(data, mapping.dataPath);
  }

  return data;
}

export async function executeWithPagination(
  baseConfig: AxiosRequestConfig,
  httpConfig: any,
): Promise<any[]> {
  const pagination = httpConfig.pagination;
  const maxPages = pagination.maxPages ?? 5;
  const allResults: any[] = [];
  let pageCount = 0;
  let nextCursor: string | null = null;
  let nextUrl: string | null = null;
  let offset = 0;

  while (pageCount < maxPages) {
    if (baseConfig.signal?.aborted) {
      break;
    }

    const pageConfig: AxiosRequestConfig = {
      ...baseConfig,
      params: { ...(baseConfig.params as Record<string, any>) },
      headers: { ...(baseConfig.headers as Record<string, string>) },
    };

    switch (pagination.type) {
      case 'cursor':
        if (nextUrl) {
          // SSRF fix: every URL pulled from an upstream response runs
          // back through validateUrl before fetch. A malicious API
          // can't redirect us into 169.254.169.254, localhost, etc.
          pageConfig.url = assertSafeNextPageUrl(nextUrl, baseConfig.url);
          pageConfig.params = undefined;
        } else if (nextCursor && pagination.cursorParam) {
          pageConfig.params = pageConfig.params || {};
          (pageConfig.params as Record<string, any>)[pagination.cursorParam] = nextCursor;
        }
        break;
      case 'offset':
        pageConfig.params = pageConfig.params || {};
        if (pagination.offsetParam)
          (pageConfig.params as Record<string, any>)[pagination.offsetParam] = offset;
        if (pagination.limitParam && pagination.defaultLimit)
          (pageConfig.params as Record<string, any>)[pagination.limitParam] =
            pagination.defaultLimit;
        break;
      case 'link-header':
        if (nextUrl) {
          pageConfig.url = assertSafeNextPageUrl(nextUrl, baseConfig.url);
          pageConfig.params = undefined;
        }
        break;
    }

    const response = await axios(pageConfig);
    const processed = processHttpResponse(response, httpConfig);

    const results = pagination.resultsPath
      ? getByDotPath(response.data, pagination.resultsPath)
      : processed;

    if (Array.isArray(results)) allResults.push(...results);
    else if (results !== undefined && results !== null) allResults.push(results);

    pageCount++;
    let hasNext = false;

    switch (pagination.type) {
      case 'cursor':
        if (pagination.cursorPath) {
          const cursor = getByDotPath(response.data, pagination.cursorPath);
          if (cursor) {
            if (
              typeof cursor === 'string' &&
              (cursor.startsWith('http') || cursor.startsWith('/'))
            ) {
              nextUrl = cursor;
              nextCursor = null;
            } else {
              nextCursor = String(cursor);
              nextUrl = null;
            }
            hasNext = true;
          }
        }
        break;
      case 'offset': {
        const limit = pagination.defaultLimit ?? 20;
        if (Array.isArray(results) && results.length >= limit) {
          offset += limit;
          hasNext = true;
        }
        break;
      }
      case 'link-header': {
        const linkHeader = response.headers?.link || response.headers?.Link;
        if (linkHeader) {
          const m = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
          if (m) {
            nextUrl = m[1];
            hasNext = true;
          }
        }
        break;
      }
    }

    if (!hasNext) break;
  }

  return allResults;
}
