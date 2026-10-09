import { headingText, markdownToEmailHtml, markdownToPlainText, toSlackMrkdwn } from '../channel-markdown';

/** Headings are read by hand: the regex for them backtracked on long runs of spaces. */
describe('markdown headings in channel posts', () => {
  it('reads one to six hashes, up to three spaces in, followed by a space', () => {
    expect(headingText('## Outreach')).toBe('Outreach');
    expect(headingText('   # Brief  ')).toBe('Brief');
    expect(headingText('####### seven')).toBeNull();
    expect(headingText('    # four spaces in')).toBeNull();
    expect(headingText('#hashtag')).toBeNull();
    expect(headingText('plain text')).toBeNull();
  });

  it('answers at once on a long line of spaces', () => {
    const line = `#${' '.repeat(50_000)}x`;
    const started = Date.now();
    expect(headingText(line)).toBe('x');
    expect(toSlackMrkdwn(line)).toBe('*x*');
    expect(markdownToPlainText(line)).toBe('x');
    expect(markdownToEmailHtml(line)).toContain('<strong>x</strong>');
    expect(Date.now() - started).toBeLessThan(500);
  });
});
