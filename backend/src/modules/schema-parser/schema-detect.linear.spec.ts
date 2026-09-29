import { ApiType } from '../../entities/api.entity';
import { SchemaNotRecognizedError, detectApiSchema } from './schema-detect';

/**
 * detectApiSchema runs in the request that connects an API, on a pasted
 * description, an uploaded file (up to 10 MB) or a fetched link, and it is
 * synchronous. Its sniffing regexes were quadratic: `^\s*` under /m
 * rescanned every blank line from every line start, and the WSDL tag
 * patterns rescanned to the end of the document from every unclosed tag.
 * 80 KB of newlines took six seconds; the upload limit, hours.
 */
describe('detectApiSchema: linear on hostile input', () => {
  const WSDL_HEAD = '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/">';

  const timed = (text: string): number => {
    const started = Date.now();
    try {
      detectApiSchema(text, {});
    } catch (err) {
      if (!(err instanceof SchemaNotRecognizedError)) throw err;
    }
    return Date.now() - started;
  };

  it.each([
    ['a run of blank lines', 'x' + '\n'.repeat(200_000) + 'x'],
    ['a run of blank lines named .proto', 'message' + '\n'.repeat(200_000) + 'x'],
    ['unclosed <address tags in a WSDL', WSDL_HEAD + '<address '.repeat(40_000)],
    ['unclosed <service tags in a WSDL', WSDL_HEAD + '<service '.repeat(40_000)],
    ['unclosed <definitions tags in a WSDL', WSDL_HEAD + '<definitions '.repeat(40_000)],
    ['an unclosed documentation body', WSDL_HEAD + '<documentation>' + '<'.repeat(60_000) + '</documentation>'],
  ])('%s', (_label, text) => {
    expect(timed(text)).toBeLessThan(1000);
  });

  it('still reads a YAML OpenAPI document with indented keys', () => {
    const detected = detectApiSchema('# spec\n  \nopenapi: 3.0.0\ninfo:\n  title: Pets\n  version: 1.0.0\npaths: {}\n');
    expect(detected.type).toBe(ApiType.OPENAPI);
    expect(detected.name).toBe('Pets');
  });

  it('still reads a WSDL name, address and documentation', () => {
    const wsdl = [
      '<?xml version="1.0"?>',
      '<wsdl:definitions name="Weather" xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/">',
      '  <wsdl:documentation>Current <b>weather</b></wsdl:documentation>',
      '  <wsdl:service name="WeatherService"><wsdl:port name="p" binding="b">',
      '    <soap:address location="https://weather.example.com/soap"/>',
      '  </wsdl:port></wsdl:service>',
      '</wsdl:definitions>',
    ].join('\n');
    const detected = detectApiSchema(wsdl);
    expect(detected.type).toBe(ApiType.SOAP);
    expect(detected.name).toBe('Weather');
    expect(detected.description).toBe('Current weather');
    expect(detected.baseUrl).toBe('https://weather.example.com/soap');
  });

  it('still reads a proto service with an indented syntax line and a leading comment', () => {
    const proto = '// Greeter API\n  syntax = "proto3";\npackage greet.v1;\nservice Greeter { rpc Hi (Req) returns (Res); }\nmessage Req { string n = 1; }\nmessage Res { string m = 1; }\n';
    const detected = detectApiSchema(proto);
    expect(detected.format).toBe('proto');
    expect(detected.name).toBe('Greeter');
    expect(detected.description).toBe('Greeter API');
  });
});
