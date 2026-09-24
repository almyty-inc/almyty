import { generateKeyPairSync, KeyObject, randomBytes } from 'crypto';
import { SignedXml } from 'xml-crypto';
import { inflateRawSync } from 'zlib';

/**
 * A SAML identity provider for unit specs: real XML, really signed.
 *
 * Not a `.spec.ts`, deliberately: jest collects `.*\.spec\.ts$`.
 *
 * Responses are built as an IdP would build them and the Assertion is
 * signed (RSA-SHA256, exclusive c14n) with xml-crypto, so node-saml's own
 * signature, audience, timestamp and InResponseTo checks run for real
 * against them. `publicKeyPem` is what an org's SAML config holds as the
 * IdP certificate. Knobs produce the responses a client must refuse.
 */

export interface SamlResponseOptions {
  inResponseTo?: string | null;
  /** SubjectConfirmationData InResponseTo, when it should differ from the Response's. */
  subjectInResponseTo?: string | null;
  acsUrl: string;
  audience: string;
  nameId?: string;
  email?: string;
  assertionId?: string;
  /** Minutes the assertion stays valid from `now`. */
  validForMinutes?: number;
  now?: number;
  /** Sign with a key the SP does not trust. */
  foreignKey?: boolean;
}

const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

export class FakeSamlIdp {
  readonly issuer: string;
  readonly entryPoint: string;
  private readonly key: { privateKey: KeyObject; publicKey: KeyObject };
  private readonly foreign: { privateKey: KeyObject; publicKey: KeyObject };

  constructor(issuer = 'https://idp.corp.test') {
    this.issuer = issuer;
    this.entryPoint = `${issuer}/sso/saml`;
    this.key = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.foreign = generateKeyPairSync('rsa', { modulusLength: 2048 });
  }

  get publicKeyPem(): string {
    return this.key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  /** The AuthnRequest ID inside an SP's redirect-binding login URL. */
  static requestIdFrom(loginUrl: string): string {
    const encoded = new URL(loginUrl).searchParams.get('SAMLRequest');
    if (!encoded) throw new Error('fake saml idp: no SAMLRequest in the login URL');
    const xml = inflateRawSync(Buffer.from(encoded, 'base64')).toString('utf8');
    const id = xml.match(/\sID="([^"]+)"/)?.[1];
    if (!id) throw new Error('fake saml idp: AuthnRequest has no ID');
    return id;
  }

  /** A base64 SAMLResponse as the IdP would POST it to the ACS. */
  response(opts: SamlResponseOptions): string {
    const now = opts.now ?? Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const until = now + (opts.validForMinutes ?? 5) * 60_000;
    const nameId = opts.nameId ?? 'ada@corp.test';
    const email = opts.email ?? nameId;
    const assertionId = opts.assertionId ?? `_a${randomBytes(12).toString('hex')}`;
    const responseIrt = opts.inResponseTo ? ` InResponseTo="${esc(opts.inResponseTo)}"` : '';
    const subjectIrtValue = opts.subjectInResponseTo === undefined ? opts.inResponseTo : opts.subjectInResponseTo;
    const subjectIrt = subjectIrtValue ? ` InResponseTo="${esc(subjectIrtValue)}"` : '';

    const assertion =
      `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${iso(now)}">` +
      `<saml:Issuer>${esc(this.issuer)}</saml:Issuer>` +
      `<saml:Subject>` +
      `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${esc(nameId)}</saml:NameID>` +
      `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
      `<saml:SubjectConfirmationData${subjectIrt} NotOnOrAfter="${iso(until)}" Recipient="${esc(opts.acsUrl)}"/>` +
      `</saml:SubjectConfirmation>` +
      `</saml:Subject>` +
      `<saml:Conditions NotBefore="${iso(now - 60_000)}" NotOnOrAfter="${iso(until)}">` +
      `<saml:AudienceRestriction><saml:Audience>${esc(opts.audience)}</saml:Audience></saml:AudienceRestriction>` +
      `</saml:Conditions>` +
      `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="_s1">` +
      `<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>` +
      `</saml:AuthnStatement>` +
      `<saml:AttributeStatement>` +
      `<saml:Attribute Name="email"><saml:AttributeValue>${esc(email)}</saml:AttributeValue></saml:Attribute>` +
      `</saml:AttributeStatement>` +
      `</saml:Assertion>`;

    const signer = new SignedXml({
      privateKey: (opts.foreignKey ? this.foreign : this.key).privateKey.export({ type: 'pkcs8', format: 'pem' }),
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    });
    signer.addReference({
      xpath: "//*[local-name(.)='Assertion']",
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    });
    signer.computeSignature(assertion, {
      location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' },
    });
    const signedAssertion = signer.getSignedXml();

    const response =
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
      `ID="_r${randomBytes(12).toString('hex')}" Version="2.0" IssueInstant="${iso(now)}" Destination="${esc(opts.acsUrl)}"${responseIrt}>` +
      `<saml:Issuer>${esc(this.issuer)}</saml:Issuer>` +
      `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
      signedAssertion +
      `</samlp:Response>`;
    return Buffer.from(response, 'utf8').toString('base64');
  }
}
