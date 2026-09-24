import { spawnSync } from 'child_process';

import {
  bashSingleQuote,
  bashWord,
  cliFlagName,
  graphqlName,
  graphqlTypeRef,
  jsDocText,
  jsIdentifier,
  jsStringLiteral,
  markdownFence,
  markdownQuotedData,
  sanitizeSchemaText,
  singleLine,
  tsPropertyKey,
  yamlScalar,
} from '../untrusted-text';

const LS = String.fromCharCode(0x2028);
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);

describe('untrusted-text', () => {
  it('drops control, bidi and zero-width characters and unifies line breaks', () => {
    expect(sanitizeSchemaText(`a\u0000b${RLO}c${ZWSP}d\r\ne${LS}f`)).toBe('abcd\ne\nf');
  });

  it('caps length with an ellipsis', () => {
    expect(singleLine('x'.repeat(50), 10)).toBe('xxxxxxx...');
  });

  it('singleLine collapses every line terminator', () => {
    expect(singleLine(`a\nb\rc${LS}d`)).toBe('a b c d');
  });

  it('bashSingleQuote round-trips through a real shell', () => {
    const hostile = `it's $(echo no) \`echo no\` "$HOME" \\ ; echo no`;
    const res = spawnSync('bash', ['-c', `printf %s ${bashSingleQuote(hostile)}`], { encoding: 'utf-8' });
    expect(res.stdout).toBe(hostile);
  });

  it('bashWord leaves plain words bare and quotes the rest', () => {
    expect(bashWord('--pet-id')).toBe('--pet-id');
    expect(bashWord('a b')).toBe("'a b'");
  });

  it('jsStringLiteral evaluates back to the sanitised input', () => {
    const hostile = `a'b"c\\d\`e\${f}${LS}g`;
    // eslint-disable-next-line no-eval
    expect(eval(jsStringLiteral(hostile))).toBe(sanitizeSchemaText(hostile));
    expect(jsStringLiteral(LS)).toBe('"\\n"');
  });

  it('jsDocText cannot close a comment', () => {
    expect(jsDocText('a */ b')).not.toContain('*/');
  });

  it('identifiers and keys', () => {
    expect(jsIdentifier('x(){};pwn()')).toBe('xpwn');
    expect(jsIdentifier('1abc')).toBe('_1abc');
    expect(jsIdentifier('delete')).toBe('delete_');
    expect(tsPropertyKey('petId')).toBe('petId');
    expect(tsPropertyKey('a: b }')).toBe('"a: b }"');
    expect(cliFlagName('petId')).toBe('pet-id');
    expect(cliFlagName('q$(touch x)')).toBe('q-touch-x');
    expect(graphqlName('a\nb')).toBe('a_b');
    expect(graphqlTypeRef('[ID!]!')).toBe('[ID!]!');
    expect(graphqlTypeRef('ID\n```')).toBe('String');
  });

  it('markdownQuotedData keeps every line inside the quote, escaped', () => {
    const out = markdownQuotedData('ok\n# heading\n```\n<b>x</b>\n![i](http://x)');
    for (const line of out.split('\n')) expect(line.startsWith('>')).toBe(true);
    expect(out).toContain('> \\# heading');
    expect(out).not.toContain('```');
    expect(out).not.toContain('<b>');
    expect(out).not.toMatch(/(^|[^\\])!\[/);
  });

  it('markdownFence outlasts backtick runs in the content', () => {
    const fenced = markdownFence('a\n````\nb', 'bash');
    expect(fenced.startsWith('`````bash\n')).toBe(true);
    expect(fenced.endsWith('\n`````')).toBe(true);
  });

  it('yamlScalar quotes anything ambiguous', () => {
    expect(yamlScalar('Find pet by ID')).toBe('Find pet by ID');
    expect(yamlScalar('a: b')).toBe('"a: b"');
    expect(yamlScalar('true')).toBe('"true"');
    expect(yamlScalar('x\n---\nname: y')).toBe('"x --- name: y"');
  });
});
