/**
 * A release entry's field labels are the answer's own layout, not a claim
 * about the release. Two release-watcher runs on staging (2026-11-19, the
 * model comparison) wrote "**URL:** https://..." under v27.0.0-alpha.0.1.1;
 * the link was dropped but the label "URL" was read as the url module, a
 * name the node changelog uses, so a correct summary failed with "names
 * url, but the release notes never mention it".
 */
import { codeFindings } from '../agent-verifier.helper';
import { evidenceOf, loadRun, wholeToolResults } from './fixtures/checker-runs/load';

function findingsOf(name: string, answer?: string) {
  const fx = loadRun(name);
  return codeFindings({
    request: fx.request,
    answer: answer ?? fx.answer,
    evidence: evidenceOf(fx),
    now: new Date(fx.now),
    whole: wholeToolResults(fx),
    instructions: fx.instructions,
  });
}

const releaseNotes = (name: string, answer?: string) => findingsOf(name, answer).filter((f) => f.code === 'release_notes');

describe("a release entry's field labels are not read as release-note terms", () => {
  it.each(['mc-RW-46e79381', 'mc-RW-39874eeb'])('%s: "**URL:**" above the link is not "url"', (name) => {
    expect(loadRun(name).stored.failures.map((f) => f.rule)).toEqual([
      "v27.0.0-alpha.0.1.1: the answer's summary names url, but the release notes in the tool results never mention it",
    ]);
    expect(releaseNotes(name)).toEqual([]);
  });

  it('plain and list-item labels with only a link after them are layout too', () => {
    const fx = loadRun('mc-RW-46e79381');
    const plain = fx.answer.replace(/\*\*URL:\*\* (\S+)/, 'URL: $1');
    expect(plain).not.toEqual(fx.answer);
    expect(releaseNotes('mc-RW-46e79381', plain)).toEqual([]);
    const listed = fx.answer.replace(/\*\*URL:\*\* (\S+)/, '- Url: <$1>');
    expect(releaseNotes('mc-RW-46e79381', listed)).toEqual([]);
  });

  it('a subsystem the summary names in prose is still checked', () => {
    const fx = loadRun('mc-RW-46e79381');
    const answer = fx.answer.replace('**Summary:**  \n', '**Summary:**  \nFixes a url parsing crash. ');
    expect(answer).not.toEqual(fx.answer);
    expect(releaseNotes('mc-RW-46e79381', answer).map((f) => f.rule)).toEqual([
      "v27.0.0-alpha.0.1.1: the answer's summary names url, but the release notes in the tool results never mention it",
    ]);
  });

  it('a changelog-style "**url**: ..." line is a claim about the url module, not a label', () => {
    const fx = loadRun('mc-RW-46e79381');
    const answer = fx.answer.replace('**Summary:**  \n', '**Summary:**  \n- **url**: fix host parsing\n');
    expect(releaseNotes('mc-RW-46e79381', answer)).toHaveLength(1);
  });
});
