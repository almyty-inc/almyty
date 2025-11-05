import { Test, TestingModule } from '@nestjs/testing';
import { SOAPParserService } from './soap-parser.service';

describe('SOAPParserService', () => {
  let service: SOAPParserService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SOAPParserService],
    }).compile();

    service = module.get<SOAPParserService>(SOAPParserService);
  });

  describe('parseSchema', () => {
    it('should parse SOAP WSDL schema successfully', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
                     targetNamespace="http://example.com/users"
                     xmlns:tns="http://example.com/users">
          <types>
            <schema targetNamespace="http://example.com/users">
              <element name="GetUserRequest">
                <complexType>
                  <sequence>
                    <element name="userId" type="string"/>
                  </sequence>
                </complexType>
              </element>
            </schema>
          </types>
          <message name="GetUserRequestMessage">
            <part name="parameters" element="tns:GetUserRequest"/>
          </message>
          <portType name="UserPortType">
            <operation name="GetUser">
              <input message="tns:GetUserRequestMessage"/>
            </operation>
          </portType>
        </definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'users.wsdl');

      expect(result.version).toBeDefined();
      expect(result.info).toBeDefined();
      expect(result.operations).toEqual(expect.any(Array));
      expect(result.resources).toEqual(expect.any(Array));
      expect(result.metadata).toEqual(expect.any(Object));
    });

    it('should handle invalid WSDL schema', async () => {
      const invalidWsdl = 'invalid xml content';

      await expect(service.parseSchema(invalidWsdl))
        .rejects
        .toThrow();
    });
  });

  describe('validateSchema', () => {
    it('should validate valid WSDL schema', async () => {
      const validWsdl = `<?xml version="1.0"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/">
          <portType name="TestPortType">
            <operation name="TestOperation"/>
          </portType>
        </definitions>`;

      const result = await service.validateSchema(validWsdl);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should return errors for invalid WSDL', async () => {
      const invalidWsdl = 'not xml at all';

      const result = await service.validateSchema(invalidWsdl);

      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should return error when definitions element is missing', async () => {
      const wsdlWithoutDefinitions = `<?xml version="1.0"?>
        <root xmlns="http://schemas.xmlsoap.org/wsdl/">
          <portType name="TestPortType">
            <operation name="TestOperation"/>
          </portType>
        </root>`;

      const result = await service.validateSchema(wsdlWithoutDefinitions);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Invalid WSDL: missing definitions element');
    });
  });

  describe('extractOperations', () => {
    it('should extract operations from parsed schema', async () => {
      const parsedSchema = {
        version: '1.1',
        info: { title: 'User Service' },
        operations: [
          {
            name: 'GetUser',
            description: 'Get user by ID',
            input: { name: 'GetUserRequest', type: 'object' },
            output: { name: 'GetUserResponse', type: 'object' }
          }
        ],
        resources: [],
        metadata: { targetNamespace: 'http://example.com/users' }
      } as any;

      const result = await service.extractOperations(parsedSchema);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('GetUser');
      expect(result[0].description).toBe('Get user by ID');
    });

    it('should return empty array for schema with no operations', async () => {
      const parsedSchema = {
        version: '1.1',
        info: { title: 'Empty Service' },
        operations: [],
        resources: [],
        metadata: {}
      } as any;

      const result = await service.extractOperations(parsedSchema);

      expect(result).toEqual([]);
    });
  });

  describe('extractResources', () => {
    it('should extract resources from parsed schema', async () => {
      const parsedSchema = {
        version: '1.1',
        info: { title: 'User Service' },
        operations: [],
        resources: [
          {
            name: 'User',
            type: 'complexType',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' }
            }
          },
          {
            name: 'UserList',
            type: 'complexType',
            properties: {
              users: { type: 'array', items: 'User' }
            }
          }
        ],
        metadata: {}
      } as any;

      const result = await service.extractResources(parsedSchema);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('User');
      expect(result[1].name).toBe('UserList');
    });

    it('should return empty array for schema with no resources', async () => {
      const parsedSchema = {
        version: '1.1',
        info: { title: 'Empty Service' },
        operations: [],
        resources: [],
        metadata: {}
      } as any;

      const result = await service.extractResources(parsedSchema);

      expect(result).toEqual([]);
    });
  });

  describe('parseSchema with advanced WSDL features', () => {
    it('should parse WSDL with multiple operations', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
                     targetNamespace="http://example.com/users"
                     xmlns:tns="http://example.com/users">
          <types>
            <schema targetNamespace="http://example.com/users">
              <element name="GetUserRequest">
                <complexType>
                  <sequence>
                    <element name="userId" type="string"/>
                  </sequence>
                </complexType>
              </element>
              <element name="CreateUserRequest">
                <complexType>
                  <sequence>
                    <element name="name" type="string"/>
                    <element name="email" type="string"/>
                  </sequence>
                </complexType>
              </element>
            </schema>
          </types>
          <message name="GetUserRequestMessage">
            <part name="parameters" element="tns:GetUserRequest"/>
          </message>
          <message name="CreateUserRequestMessage">
            <part name="parameters" element="tns:CreateUserRequest"/>
          </message>
          <portType name="UserPortType">
            <operation name="GetUser">
              <input message="tns:GetUserRequestMessage"/>
            </operation>
            <operation name="CreateUser">
              <input message="tns:CreateUserRequestMessage"/>
            </operation>
          </portType>
        </definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'users.wsdl');

      expect(result.operations).toEqual(expect.any(Array));
      expect(result.operations.length).toBeGreaterThanOrEqual(2);
    });

    it('should parse WSDL with binding and service definitions', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
                     xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
                     targetNamespace="http://example.com/users"
                     xmlns:tns="http://example.com/users">
          <types>
            <schema targetNamespace="http://example.com/users">
              <element name="TestRequest" type="string"/>
            </schema>
          </types>
          <message name="TestMessage">
            <part name="body" element="tns:TestRequest"/>
          </message>
          <portType name="TestPortType">
            <operation name="TestOperation">
              <input message="tns:TestMessage"/>
            </operation>
          </portType>
          <binding name="TestBinding" type="tns:TestPortType">
            <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
            <operation name="TestOperation">
              <soap:operation soapAction="http://example.com/TestOperation"/>
              <input>
                <soap:body use="literal"/>
              </input>
            </operation>
          </binding>
          <service name="TestService">
            <port name="TestPort" binding="tns:TestBinding">
              <soap:address location="http://example.com/service"/>
            </port>
          </service>
        </definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'test.wsdl');

      expect(result.operations).toEqual(expect.any(Array));
      expect(result.metadata).toEqual(expect.any(Object));
    });

    it('should parse WSDL with complex types', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
                     targetNamespace="http://example.com/users">
          <types>
            <schema targetNamespace="http://example.com/users">
              <complexType name="Address">
                <sequence>
                  <element name="street" type="string"/>
                  <element name="city" type="string"/>
                  <element name="country" type="string"/>
                </sequence>
              </complexType>
              <complexType name="User">
                <sequence>
                  <element name="id" type="string"/>
                  <element name="name" type="string"/>
                  <element name="address" type="tns:Address"/>
                </sequence>
              </complexType>
            </schema>
          </types>
          <portType name="UserPortType">
            <operation name="GetUser"/>
          </portType>
        </definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'complex.wsdl');

      expect(result.resources).toEqual(expect.any(Array));
    });

    it('should parse WSDL with array types', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
                     targetNamespace="http://example.com/users">
          <types>
            <schema targetNamespace="http://example.com/users">
              <complexType name="UserList">
                <sequence>
                  <element name="users" type="string" maxOccurs="unbounded"/>
                </sequence>
              </complexType>
            </schema>
          </types>
          <portType name="UserPortType">
            <operation name="ListUsers"/>
          </portType>
        </definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'arrays.wsdl');

      expect(result.resources).toEqual(expect.any(Array));
      expect(result.resources.some(r => r.name === 'UserList')).toBe(true);
      expect(result.operations).toEqual(expect.any(Array));
      expect(result.metadata.schemaType).toBe('soap');
    });

    it('should extract complex types with properties', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
                     targetNamespace="http://example.com/test">
          <types>
            <schema targetNamespace="http://example.com/test">
              <complexType name="Person">
                <sequence>
                  <element name="name" type="string"/>
                  <element name="age" type="int"/>
                  <element name="email" type="string" minOccurs="0"/>
                </sequence>
              </complexType>
            </schema>
          </types>
          <portType name="TestPortType">
            <operation name="test"/>
          </portType>
        </definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'complex.wsdl');

      expect(result.resources.length).toBeGreaterThan(0);
      const personType = result.resources.find(r => r.name === 'Person');
      expect(personType).toBeDefined();
      expect(personType.properties.name).toBeDefined();
      expect(personType.properties.age).toBeDefined();
      expect(personType.properties.name.type).toBe('string');
      expect(personType.properties.age.type).toBe('integer');
      expect(personType.properties.email.required).toBe(false);
    });

    it('should extract enumeration types', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
                     targetNamespace="http://example.com/test">
          <types>
            <schema targetNamespace="http://example.com/test">
              <simpleType name="Status">
                <restriction base="string">
                  <enumeration value="active"/>
                  <enumeration value="inactive"/>
                  <enumeration value="pending"/>
                </restriction>
              </simpleType>
            </schema>
          </types>
          <portType name="TestPortType">
            <operation name="test"/>
          </portType>
        </definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'enum.wsdl');

      expect(result.resources.length).toBeGreaterThan(0);
      const statusEnum = result.resources.find(r => r.name === 'Status');
      expect(statusEnum).toBeDefined();
      expect(statusEnum.schema.type).toBe('string');
      expect(statusEnum.schema.enum).toContain('active');
      expect(statusEnum.schema.enum).toContain('inactive');
      expect(statusEnum.schema.enum).toContain('pending');
    });

    it('should map XML types to JSON types correctly', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
                     targetNamespace="http://example.com/test">
          <types>
            <schema targetNamespace="http://example.com/test">
              <complexType name="TypeTest">
                <sequence>
                  <element name="stringField" type="string"/>
                  <element name="intField" type="int"/>
                  <element name="longField" type="long"/>
                  <element name="floatField" type="float"/>
                  <element name="doubleField" type="double"/>
                  <element name="boolField" type="boolean"/>
                  <element name="dateField" type="date"/>
                </sequence>
              </complexType>
            </schema>
          </types>
          <portType name="TestPortType">
            <operation name="test"/>
          </portType>
        </definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'types.wsdl');

      const typeTest = result.resources.find(r => r.name === 'TypeTest');
      expect(typeTest).toBeDefined();
      expect(typeTest.properties.stringField.type).toBe('string');
      expect(typeTest.properties.intField.type).toBe('integer');
      expect(typeTest.properties.longField.type).toBe('integer');
      expect(typeTest.properties.floatField.type).toBe('number');
      expect(typeTest.properties.doubleField.type).toBe('number');
      expect(typeTest.properties.boolField.type).toBe('boolean');
      expect(typeTest.properties.dateField.type).toBe('string');
    });

    it('should handle empty complex types', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
                     targetNamespace="http://example.com/test">
          <types>
            <schema targetNamespace="http://example.com/test">
              <complexType name="EmptyType"/>
            </schema>
          </types>
          <portType name="TestPortType">
            <operation name="test"/>
          </portType>
        </definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'empty.wsdl');

      const emptyType = result.resources.find(r => r.name === 'EmptyType');
      expect(emptyType).toBeDefined();
      expect(emptyType.properties).toEqual({});
    });

    it('should handle WSDL with wsdl: namespace prefix', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
                          name="TestService"
                          targetNamespace="http://example.com/test">
          <wsdl:types>
            <schema>
              <complexType name="TestType">
                <sequence>
                  <element name="field" type="string"/>
                </sequence>
              </complexType>
            </schema>
          </wsdl:types>
          <wsdl:portType name="TestPort">
            <wsdl:operation name="testOp">
              <wsdl:documentation>Test operation</wsdl:documentation>
            </wsdl:operation>
          </wsdl:portType>
        </wsdl:definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'ns-prefixed.wsdl');

      expect(result.info.title).toBe('TestService');
      expect(result.metadata.targetNamespace).toBe('http://example.com/test');
      expect(result.operations.length).toBeGreaterThan(0);
    });

    it('should handle WSDL without name attribute (use default)', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
                     targetNamespace="http://example.com/test">
          <portType name="TestPort">
            <operation name="testOp"/>
          </portType>
        </definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'unnamed.wsdl');

      expect(result.info.title).toBe('SOAP Service');
    });

    it('should handle WSDL without targetNamespace', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/">
          <portType name="TestPort">
            <operation name="testOp"/>
          </portType>
        </definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'no-namespace.wsdl');

      // When there's no $ attribute on definitions, targetNamespace will be undefined or ''
      expect([undefined, '']).toContain(result.metadata.targetNamespace);
    });

    it('should handle operation without $ attribute', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/">
          <portType name="TestPort">
            <operation/>
          </portType>
        </definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'no-op-attr.wsdl');

      expect(result.operations).toEqual([]);
    });

    it('should handle array documentation field', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/">
          <portType name="TestPort">
            <operation name="testOp">
              <documentation>First doc</documentation>
              <documentation>Second doc</documentation>
            </operation>
          </portType>
        </definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'multi-doc.wsdl');

      expect(result.operations.length).toBe(1);
      expect(result.operations[0].description).toBeDefined();
    });

    it('should handle schema with xs: namespace prefix', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/">
          <types>
            <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
              <xs:complexType name="XsType">
                <xs:sequence>
                  <xs:element name="field" type="xs:string"/>
                </xs:sequence>
              </xs:complexType>
              <xs:simpleType name="XsEnum">
                <xs:restriction base="xs:string">
                  <xs:enumeration value="val1"/>
                  <xs:enumeration value="val2"/>
                </xs:restriction>
              </xs:simpleType>
            </xs:schema>
          </types>
          <portType name="TestPort">
            <operation name="test"/>
          </portType>
        </definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'xs-prefix.wsdl');

      const xsType = result.resources.find(r => r.name === 'XsType');
      expect(xsType).toBeDefined();
      expect(xsType.properties.field.type).toBe('string');

      // SimpleType with xs: prefix is handled
      expect(result.resources.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle schema with xsd: namespace prefix', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/">
          <types>
            <xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema">
              <xsd:complexType name="XsdType">
                <xsd:sequence>
                  <xsd:element name="field" type="xsd:int"/>
                </xsd:sequence>
              </xsd:complexType>
              <xsd:simpleType name="XsdEnum">
                <xsd:restriction base="xsd:string">
                  <xsd:enumeration value="a"/>
                </xsd:restriction>
              </xsd:simpleType>
            </xsd:schema>
          </types>
          <portType name="TestPort">
            <operation name="test"/>
          </portType>
        </definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'xsd-prefix.wsdl');

      const xsdType = result.resources.find(r => r.name === 'XsdType');
      expect(xsdType).toBeDefined();
      expect(xsdType.properties.field.type).toBe('integer');

      // SimpleType with xsd: prefix is handled
      expect(result.resources.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle single enumeration value (not array)', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/">
          <types>
            <schema>
              <simpleType name="SingleEnum">
                <restriction base="string">
                  <enumeration value="onlyOne"/>
                </restriction>
              </simpleType>
            </schema>
          </types>
          <portType name="TestPort">
            <operation name="test"/>
          </portType>
        </definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'single-enum.wsdl');

      const singleEnum = result.resources.find(r => r.name === 'SingleEnum');
      expect(singleEnum).toBeDefined();
      if (singleEnum) {
        expect(singleEnum.schema.enum).toBeDefined();
        expect(Array.isArray(singleEnum.schema.enum)).toBe(true);
      }
    });

    it('should handle element without $ attribute in complex type', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/">
          <types>
            <schema>
              <complexType name="TestType">
                <sequence>
                  <element/>
                </sequence>
              </complexType>
            </schema>
          </types>
          <portType name="TestPort">
            <operation name="test"/>
          </portType>
        </definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'no-elem-attr.wsdl');

      const testType = result.resources.find(r => r.name === 'TestType');
      expect(testType).toBeDefined();
      expect(Object.keys(testType.properties).length).toBe(0);
    });

    it('should handle complex type without $ attribute', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/">
          <types>
            <schema>
              <complexType/>
            </schema>
          </types>
          <portType name="TestPort">
            <operation name="test"/>
          </portType>
        </definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'no-type-attr.wsdl');

      expect(result.resources).toBeDefined();
    });

    it('should handle simple type without $ attribute', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/">
          <types>
            <schema>
              <simpleType/>
            </schema>
          </types>
          <portType name="TestPort">
            <operation name="test"/>
          </portType>
        </definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'no-simple-attr.wsdl');

      expect(result.resources).toBeDefined();
    });

    it('should handle simple type without restriction enumeration', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/">
          <types>
            <schema>
              <simpleType name="NoEnum">
                <restriction base="string">
                  <maxLength value="10"/>
                </restriction>
              </simpleType>
            </schema>
          </types>
          <portType name="TestPort">
            <operation name="test"/>
          </portType>
        </definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'no-enum.wsdl');

      expect(result.resources).toBeDefined();
      const noEnum = result.resources.find(r => r.name === 'NoEnum');
      expect(noEnum).toBeUndefined();
    });

    it('should handle XML type mapping with namespace prefixes', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/">
          <types>
            <schema>
              <complexType name="TypeMapping">
                <sequence>
                  <element name="field1" type="xs:normalizedString"/>
                  <element name="field2" type="xs:token"/>
                  <element name="field3" type="xs:integer"/>
                  <element name="field4" type="xs:short"/>
                  <element name="field5" type="xs:byte"/>
                  <element name="field6" type="xs:decimal"/>
                  <element name="field7" type="xs:dateTime"/>
                  <element name="field8" type="xs:time"/>
                  <element name="field9" type="xs:unknownType"/>
                </sequence>
              </complexType>
            </schema>
          </types>
          <portType name="TestPort">
            <operation name="test"/>
          </portType>
        </definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'type-mapping.wsdl');

      const typeMapping = result.resources.find(r => r.name === 'TypeMapping');
      expect(typeMapping).toBeDefined();
      expect(typeMapping.properties.field1.type).toBe('string');
      expect(typeMapping.properties.field2.type).toBe('string');
      expect(typeMapping.properties.field3.type).toBe('integer');
      expect(typeMapping.properties.field4.type).toBe('integer');
      expect(typeMapping.properties.field5.type).toBe('integer');
      expect(typeMapping.properties.field6.type).toBe('number');
      expect(typeMapping.properties.field7.type).toBe('string');
      expect(typeMapping.properties.field8.type).toBe('string');
      expect(typeMapping.properties.field9.type).toBe('object');
    });

    it('should handle null portType array', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/">
        </definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'no-porttype.wsdl');

      expect(result.operations).toEqual([]);
    });

    it('should handle empty types element', async () => {
      const wsdlSchema = `<?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://schemas.xmlsoap.org/wsdl/">
          <types/>
          <portType name="TestPort">
            <operation name="test"/>
          </portType>
        </definitions>`;

      const result = await service.parseSchema(wsdlSchema, 'empty-types.wsdl');

      expect(result.resources).toBeDefined();
    });
  });
});