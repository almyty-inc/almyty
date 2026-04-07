import { Injectable, Logger } from '@nestjs/common';
import * as xml2js from 'xml2js';

import { Operation, OperationType, HttpMethod } from '../../../entities/operation.entity';
import { Resource, ResourceType } from '../../../entities/resource.entity';
import { SchemaParser, ParsedSchema, ParsedOperation, ParsedResource } from '../interfaces/parser.interface';

/** Hard cap on WSDL schema size — protects against memory DoS. */
const MAX_WSDL_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Reject WSDL documents that contain a DOCTYPE declaration. xml2js uses
 * sax-js under the hood, which is a non-validating parser and does NOT
 * resolve external DTD entities by default — but it WILL process a
 * locally-defined recursive entity declaration (the "billion laughs" /
 * entity-expansion DoS). We don't need DTDs for WSDL parsing, so the
 * simplest defense is to reject any input that declares one.
 */
function assertNoDoctype(xml: string): void {
  // Match `<!DOCTYPE` with any leading whitespace, case-insensitive.
  if (/<!DOCTYPE/i.test(xml)) {
    throw new Error('WSDL must not contain a DOCTYPE declaration');
  }
}

@Injectable()
export class SOAPParserService implements SchemaParser {
  private readonly logger = new Logger(SOAPParserService.name);

  async parseSchema(rawSchema: string, fileName?: string): Promise<ParsedSchema> {
    try {
      if (typeof rawSchema === 'string' && rawSchema.length > MAX_WSDL_BYTES) {
        throw new Error(`WSDL exceeds max size of ${MAX_WSDL_BYTES} bytes`);
      }
      assertNoDoctype(rawSchema);

      const parser = new xml2js.Parser();
      const wsdl = await parser.parseStringPromise(rawSchema);

      const operations = await this.extractOperationsFromWSDL(wsdl);
      const resources = await this.extractResourcesFromWSDL(wsdl);

      // Extract basic info from WSDL. Use defensive access — a WSDL
      // without a top-level `definitions.$` attribute bag would
      // previously crash with "Cannot read properties of undefined".
      const definitions = wsdl.definitions || wsdl['wsdl:definitions'] || {};
      const definitionsAttrs = definitions.$ || {};
      const targetNamespace = definitionsAttrs.targetNamespace || '';

      return {
        version: '1.0',
        info: {
          title: definitionsAttrs.name || 'SOAP Service',
          description: `SOAP Web Service (${targetNamespace})`,
          version: '1.0',
        },
        operations,
        resources,
        metadata: {
          fileName,
          schemaType: 'soap',
          targetNamespace,
          originalWSDL: wsdl,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to parse SOAP/WSDL schema: ${error.message}`);
      throw new Error(`Invalid SOAP/WSDL schema: ${error.message}`);
    }
  }

  async validateSchema(schema: string): Promise<{ isValid: boolean; errors: string[] }> {
    try {
      if (typeof schema === 'string' && schema.length > MAX_WSDL_BYTES) {
        return { isValid: false, errors: [`WSDL exceeds max size of ${MAX_WSDL_BYTES} bytes`] };
      }
      assertNoDoctype(schema);

      const parser = new xml2js.Parser();
      const parsed = await parser.parseStringPromise(schema);

      // Basic WSDL validation - check for required elements
      if (!parsed.definitions && !parsed['wsdl:definitions']) {
        return {
          isValid: false,
          errors: ['Invalid WSDL: missing definitions element'],
        };
      }

      return { isValid: true, errors: [] };
    } catch (error) {
      return {
        isValid: false,
        errors: [error.message],
      };
    }
  }

  async extractOperations(schema: ParsedSchema): Promise<Operation[]> {
    const operations: Operation[] = [];

    for (const parsedOp of schema.operations) {
      const operation = new Operation();
      operation.name = parsedOp.name;
      operation.operationId = parsedOp.operationId;
      operation.description = parsedOp.description;
      operation.method = HttpMethod.POST; // SOAP typically uses POST
      operation.endpoint = '/soap';
      operation.type = OperationType.RPC;
      operation.parameters = parsedOp.parameters;
      operation.responses = parsedOp.responses;
      operation.tags = parsedOp.tags;
      operation.isActive = true;

      operations.push(operation);
    }

    return operations;
  }

  async extractResources(schema: ParsedSchema): Promise<Resource[]> {
    const resources: Resource[] = [];

    for (const parsedResource of schema.resources) {
      const resource = new Resource();
      resource.name = parsedResource.name;
      resource.description = parsedResource.description;
      resource.type = parsedResource.type as ResourceType;
      resource.properties = parsedResource.properties;
      resource.schema = parsedResource.schema;
      resource.isActive = true;

      resources.push(resource);
    }

    return resources;
  }

  private async extractOperationsFromWSDL(wsdl: any): Promise<ParsedOperation[]> {
    const operations: ParsedOperation[] = [];
    const definitions = wsdl.definitions || wsdl['wsdl:definitions'] || {};

    // Extract operations from portType
    const portTypes = definitions.portType || definitions['wsdl:portType'] || [];
    const portTypeArray = Array.isArray(portTypes) ? portTypes : [portTypes];

    for (const portType of portTypeArray) {
      if (!portType) continue;

      const operationsArray = portType.operation || portType['wsdl:operation'] || [];
      const operations_list = Array.isArray(operationsArray) ? operationsArray : [operationsArray];

      for (const op of operations_list) {
        if (!op || !op.$) continue;

        const operationName = op.$.name;
        const documentation = op.documentation || op['wsdl:documentation'];

        operations.push({
          operationId: operationName,
          name: operationName,
          description: documentation ? (Array.isArray(documentation) ? documentation[0] : documentation) : undefined,
          method: 'soap',
          endpoint: '/soap',
          parameters: {
            body: {
              soapEnvelope: {
                type: 'object',
                description: 'SOAP envelope containing the operation request',
                properties: {
                  'soap:Envelope': {
                    type: 'object',
                    properties: {
                      'soap:Body': {
                        type: 'object',
                        properties: {
                          [operationName]: {
                            type: 'object',
                            description: `${operationName} operation parameters`,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            header: {
              'Content-Type': {
                type: 'string',
                default: 'text/xml; charset=utf-8',
              },
              'SOAPAction': {
                type: 'string',
                description: 'SOAP Action header',
              },
            },
          },
          responses: {
            '200': {
              description: 'SOAP response',
              schema: {
                type: 'object',
                properties: {
                  'soap:Envelope': {
                    type: 'object',
                    properties: {
                      'soap:Body': {
                        type: 'object',
                        properties: {
                          [`${operationName}Response`]: {
                            type: 'object',
                            description: `${operationName} operation response`,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            '500': {
              description: 'SOAP fault',
              schema: {
                type: 'object',
                properties: {
                  'soap:Envelope': {
                    type: 'object',
                    properties: {
                      'soap:Body': {
                        type: 'object',
                        properties: {
                          'soap:Fault': {
                            type: 'object',
                            properties: {
                              faultcode: { type: 'string' },
                              faultstring: { type: 'string' },
                              detail: { type: 'object' },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          tags: ['soap'],
        });
      }
    }

    return operations;
  }

  private async extractResourcesFromWSDL(wsdl: any): Promise<ParsedResource[]> {
    const resources: ParsedResource[] = [];
    const definitions = wsdl.definitions || wsdl['wsdl:definitions'] || {};

    // Extract types from schema - handle xml2js array parsing
    const typesElement = definitions.types || definitions['wsdl:types'] || {};
    const types = Array.isArray(typesElement) ? typesElement[0] : typesElement;
    const schemas = types?.schema || types?.['xs:schema'] || types?.['xsd:schema'] || [];
    const schemaArray = Array.isArray(schemas) ? schemas : [schemas];

    for (const schema of schemaArray) {
      if (!schema) continue;

      // Extract complex types
      const complexTypes = schema.complexType || schema['xs:complexType'] || schema['xsd:complexType'] || [];
      const complexTypeArray = Array.isArray(complexTypes) ? complexTypes : [complexTypes];

      for (const complexType of complexTypeArray) {
        if (!complexType || !complexType.$) continue;

        const typeName = complexType.$.name;
        const properties = this.extractPropertiesFromComplexType(complexType);

        resources.push({
          name: typeName,
          description: `SOAP complex type: ${typeName}`,
          type: ResourceType.MODEL,
          properties,
          schema: {
            type: 'object',
            properties,
            description: `SOAP complex type: ${typeName}`,
          },
        });
      }

      // Extract simple types (enums)
      const simpleTypes = schema.simpleType || schema['xs:simpleType'] || schema['xsd:simpleType'] || [];
      const simpleTypeArray = Array.isArray(simpleTypes) ? simpleTypes : [simpleTypes];

      for (const simpleType of simpleTypeArray) {
        if (!simpleType || !simpleType.$) continue;

        const typeName = simpleType.$.name;
        const restrictionElement = simpleType.restriction || simpleType['xs:restriction'] || simpleType['xsd:restriction'];
        const restriction = Array.isArray(restrictionElement) ? restrictionElement[0] : restrictionElement;

        if (restriction && restriction.enumeration) {
          const enumerations = Array.isArray(restriction.enumeration) ? restriction.enumeration : [restriction.enumeration];
          const enumValues = enumerations.map(e => e.$.value);

          resources.push({
            name: typeName,
            description: `SOAP enumeration: ${typeName}`,
            type: ResourceType.ENUM,
            properties: {},
            schema: {
              type: 'string',
              enum: enumValues,
              description: `SOAP enumeration: ${typeName}`,
            },
          });
        }
      }
    }

    return resources;
  }

  private extractPropertiesFromComplexType(complexType: any): Record<string, any> {
    const properties: Record<string, any> = {};

    // Handle sequence - xml2js wraps in array
    const sequenceElement = complexType.sequence || complexType['xs:sequence'] || complexType['xsd:sequence'];
    if (sequenceElement) {
      const sequence = Array.isArray(sequenceElement) ? sequenceElement[0] : sequenceElement;
      const elements = sequence?.element || sequence?.['xs:element'] || sequence?.['xsd:element'] || [];
      const elementArray = Array.isArray(elements) ? elements : [elements];

      for (const element of elementArray) {
        if (!element || !element.$) continue;

        const elementName = element.$.name;
        const elementType = element.$.type;

        properties[elementName] = {
          type: this.mapXMLTypeToJsonType(elementType),
          description: element.$.documentation || `Element: ${elementName}`,
          required: element.$.minOccurs !== '0',
        };
      }
    }

    return properties;
  }

  private mapXMLTypeToJsonType(xmlType: string): string {
    if (!xmlType) return 'string';

    // Remove namespace prefixes
    const type = xmlType.includes(':') ? xmlType.split(':')[1] : xmlType;

    switch (type) {
      case 'string':
      case 'normalizedString':
      case 'token':
        return 'string';
      case 'int':
      case 'integer':
      case 'long':
      case 'short':
      case 'byte':
        return 'integer';
      case 'decimal':
      case 'float':
      case 'double':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'date':
      case 'dateTime':
      case 'time':
        return 'string';
      default:
        return 'object';
    }
  }
}