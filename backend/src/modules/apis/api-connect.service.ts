import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Api } from '../../entities/api.entity';
import { ResourceVisibility } from '../../common/authorization/access-policy.service';
import { nameTaken } from '../../common/authorization/private-visibility';
import { assertOutboundUrlAllowed, EgressError } from '../../common/security/safe-fetch';
import { DetectedApi, DetectedAuth, DetectedAuthType, SchemaNotRecognizedError, detectApiSchema } from '../schema-parser/schema-detect';
import { ApisImportHelper } from './apis-import.helper';
import { ApisService } from './apis.service';

/** Same ceiling the schema import itself enforces. */
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

export const LINK_NOT_A_DESCRIPTION = "This link doesn't return an API description.";
export const LINK_PRIVATE = "almyty can't open links to private or local addresses.";

/** Exactly one of these three: a link, an uploaded file, or pasted text. */
export interface DescribeInput {
  file?: { buffer: Buffer; originalname?: string };
  url?: string;
  content?: string;
}

export interface ConnectApiInput extends DescribeInput {
  organizationId: string;
  userId?: string;
  /** Advanced overrides. Everything else is read from the description. */
  name?: string;
  baseUrl?: string;
  authType?: DetectedAuthType;
  visibility?: ResourceVisibility;
  teamId?: string | null;
}

export interface ConnectApiResult {
  api: Api;
  /** The text the import job parses (introspection comes back as SDL). */
  content: string;
  fileName?: string;
  detected: Omit<DetectedApi, 'content'>;
  /** What is left for the person to give: a key, and the address when the description has none. */
  needs: { key: boolean; address: boolean };
}

/**
 * Connect an API from its description in one step: read the link, file or
 * pasted text, work out what it is (schema-detect), and create the API
 * with everything the description says. The caller queues the import.
 */
@Injectable()
export class ApiConnectService {
  constructor(
    @InjectRepository(Api)
    private readonly apiRepository: Repository<Api>,
    private readonly apis: ApisService,
    private readonly importHelper: ApisImportHelper,
  ) {}

  async connect(input: ConnectApiInput): Promise<ConnectApiResult> {
    const detected = await this.describe(input);

    const baseUrl = input.baseUrl?.trim() || detected.baseUrl || '';
    if (input.baseUrl?.trim() && !/^https?:\/\/.+/i.test(input.baseUrl.trim())) {
      throw new BadRequestException('The address must start with http:// or https://.');
    }

    const auth: DetectedAuth =
      input.authType && input.authType !== detected.auth.type ? { type: input.authType } : detected.auth;
    const config: Record<string, any> = {};
    if (auth.type === 'api_key') {
      config.headerName = auth.headerName ?? 'X-API-Key';
      config.location = auth.location ?? 'header';
    }
    if (auth.type === 'oauth2' && auth.oauth2) {
      config.flow = auth.oauth2.flow;
      if (auth.oauth2.authorizationUrl) config.authUrl = auth.oauth2.authorizationUrl;
      config.tokenUrl = auth.oauth2.tokenUrl;
      config.scopes = auth.oauth2.scopes;
    }

    const name = await this.nameFor(input.organizationId, input.name?.trim(), detected.name);

    const api = await this.apis.create(
      {
        organizationId: input.organizationId,
        name,
        type: detected.type,
        baseUrl,
        version: detected.version ?? undefined,
        description: detected.description ? detected.description.slice(0, 1000) : undefined,
        authentication: { type: auth.type, config },
        metadata: {
          importedFrom: {
            format: detected.format,
            ...(input.url ? { url: input.url.trim() } : {}),
            ...(input.file?.originalname ? { fileName: input.file.originalname } : {}),
          },
        },
        ...(input.visibility ? { visibility: input.visibility } : {}),
        ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
      } as any,
      input.userId,
    );

    const { content, ...rest } = detected;
    return {
      api,
      content,
      fileName: input.file?.originalname,
      detected: { ...rest, auth },
      needs: { key: auth.type !== 'none', address: !baseUrl },
    };
  }

  /**
   * Read the one link, file or pasted text and say what it is. Refuses in
   * plain words when it is none of the formats almyty imports.
   */
  async describe(input: DescribeInput): Promise<DetectedApi> {
    const sources = [input.file, input.url?.trim(), input.content?.trim()].filter(Boolean);
    if (sources.length === 0) throw new BadRequestException('Paste a link, drop a file, or paste the description.');
    if (sources.length > 1) throw new BadRequestException('Give one link, file or pasted description, not several.');
    return this.read(input);
  }

  /** The description, from whichever of link, file or text was given, and what it is. */
  private async read(input: DescribeInput): Promise<DetectedApi> {
    if (input.file) {
      const text = input.file.buffer.toString('utf-8');
      this.assertSize(text);
      return this.detect(text, { fileName: input.file.originalname });
    }
    if (input.content?.trim()) {
      this.assertSize(input.content);
      return this.detect(input.content, {});
    }

    const url = input.url!.trim();
    if (!/^https?:\/\//i.test(url)) throw new BadRequestException('A link starts with http:// or https://.');
    try {
      assertOutboundUrlAllowed(url);
    } catch (err) {
      if (err instanceof EgressError) throw new BadRequestException(LINK_PRIVATE);
      throw err;
    }

    // An ordinary document first: an OpenAPI/Swagger JSON or YAML, a
    // WSDL, a .proto or .graphql file.
    let text: string | null = null;
    try {
      text = await this.importHelper.fetchSchemaFromUrl(url);
    } catch {
      text = null;
    }
    if (text !== null) {
      this.assertSize(text);
      try {
        return detectApiSchema(text, { sourceUrl: url, fileName: fileNameOf(url) });
      } catch (err) {
        if (!(err instanceof SchemaNotRecognizedError)) throw err;
      }
    }

    // Not a document: maybe a GraphQL endpoint, which describes itself
    // when asked.
    const introspection = await this.importHelper.fetchGraphQLIntrospection(url).catch(() => null);
    if (introspection) {
      try {
        return detectApiSchema(introspection, { sourceUrl: url, graphqlEndpoint: url });
      } catch (err) {
        if (!(err instanceof SchemaNotRecognizedError)) throw err;
      }
    }
    throw new BadRequestException({ code: 'LINK_NOT_A_DESCRIPTION', message: LINK_NOT_A_DESCRIPTION });
  }

  private detect(text: string, opts: { fileName?: string }): DetectedApi {
    try {
      return detectApiSchema(text, opts);
    } catch (err) {
      if (err instanceof SchemaNotRecognizedError) {
        throw new BadRequestException({ code: err.code, message: err.message });
      }
      throw err;
    }
  }

  private assertSize(text: string): void {
    if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) {
      throw new BadRequestException('This description is too big to import (the limit is 100 MB).');
    }
  }

  /**
   * The name typed under Advanced is used as given (and refused when taken,
   * as everywhere else). A name read from the description gets " 2", " 3"
   * when the organization already has one: nobody typed it, so a clash is
   * ours to sort out, not theirs.
   */
  private async nameFor(organizationId: string, typed: string | undefined, detected: string | null): Promise<string> {
    if (typed) {
      if (await this.taken(organizationId, typed)) throw nameTaken('API', typed);
      return typed.slice(0, 100);
    }
    const base = (detected ?? 'Imported API').slice(0, 94);
    if (!(await this.taken(organizationId, base))) return base;
    for (let n = 2; n < 100; n++) {
      const candidate = `${base} ${n}`;
      if (!(await this.taken(organizationId, candidate))) return candidate;
    }
    throw nameTaken('API', base);
  }

  private async taken(organizationId: string, name: string): Promise<boolean> {
    return !!(await this.apiRepository.findOne({ where: { organizationId, name }, select: { id: true } }));
  }
}

function fileNameOf(url: string): string | undefined {
  try {
    const last = new URL(url).pathname.split('/').pop();
    return last && /\.[a-z0-9]+$/i.test(last) ? last : undefined;
  } catch {
    return undefined;
  }
}
