import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Nothing in this repo accepts a setting it does not read.
 *
 * An unwired control is a field or method that exists, compiles, is
 * exercised by its own unit test and rendered by the UI, and is read by
 * nothing at run time. A behavioural test cannot catch one: a test of a
 * value that round-trips passes identically whether or not anything
 * consumes it, which is how every entry below survived a green suite. So
 * this guard reads the source.
 *
 * Two kinds of entry.
 *
 * DELETED — the control was removed, because honouring it would have
 * meant designing a feature and leaving it in place meant telling users
 * a knob works. These arms fail if the name comes back in live code.
 *
 * NOT IMPLEMENTED — the control stays, because its columns are real and
 * a future implementation would use exactly it, but nothing calls it and
 * the code says so in as many words. These arms fail in BOTH directions:
 * if the label disappears, or if something starts calling the thing
 * while the label still says it is dead.
 */
describe('no control is stored and then ignored', () => {
  const repo = join(__dirname, '..', '..', '..');
  const src = (rel: string) => readFileSync(join(repo, rel), 'utf8');

  /**
   * Search the hand-written source: tracked .ts/.tsx under the four
   * source roots. Deliberately `git grep` rather than a filesystem walk,
   * so a developer's node_modules, dist or coverage output never answers
   * for the repository.
   *
   * Note this runs with ERE, where `\b` is not portable — bound a word
   * with an explicit character class instead.
   */
  const grep = (pattern: string): string[] => {
    const roots = ['backend/src', 'backend/ee', 'frontend/src', 'packages'];
    let out = '';
    try {
      out = execFileSync(
        'git',
        [
          'grep',
          '-I',
          '-n',
          '-E',
          pattern,
          '--',
          ...roots.map((r) => `${r}/**/*.ts`),
          ...roots.map((r) => `${r}/**/*.tsx`),
        ],
        { cwd: repo, encoding: 'utf8' },
      );
    } catch (err: any) {
      // git grep exits 1 with no output when nothing matched.
      if (err?.status === 1) return [];
      throw err;
    }
    return (
      out
        .split('\n')
        .filter(Boolean)
        // A guard that names a dead thing in order to forbid it is not a
        // use of it, and neither is a comment recording why it went.
        // What this hunts is a live reference in shipped code.
        .filter((line) => !/\.guard\.spec\.ts:/.test(line))
        .filter((line) => {
          const body = line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1).trim();
          return !(body.startsWith('//') || body.startsWith('*') || body.startsWith('/*'));
        })
    );
  };

  describe('deleted, because wiring them would have meant inventing a feature', () => {
    /**
     * Gateway.rateLimitConfig.burstLimit / windowSize. Accepted by both
     * halves of the gateway DTO, stored, and ignored: GatewayRateLimitService
     * fixes its windows at 60s/3600s/86400s and derives a burst allowance
     * from perVisitorPerHour itself. A second, conflicting source for two
     * knobs the service already answers is how the first one stops being
     * trustworthy. The rate-limiter plugin carried an unread `burstLimit`
     * default of its own on an independent path; that went too.
     */
    it('burstLimit and windowSize are gone', () => {
      expect(grep('(burstLimit|windowSize)([^A-Za-z0-9_]|$)')).toEqual([]);
    });

    /**
     * Agent.collaboration.rules.allowRevision / sharedMemoryScope. Two
     * checkboxes in autonomous-config.tsx wrote them; the run engine reads
     * the other five keys in `rules` and never these. Neither names an
     * existing mechanism — a revision pass and a shared memory scope are
     * features to design, not calls to add.
     */
    it('allowRevision and sharedMemoryScope are gone', () => {
      expect(grep('allowRevision|sharedMemoryScope')).toEqual([]);
    });

    /**
     * BuiltInPluginType. Ten snake_case members, imported into
     * plugin-manager.service.ts and never once referenced. Actively
     * misleading as well as dead: plugin ids are slugified from the
     * display name, so the live vocabulary is hyphenated
     * (`rate-limiter`), and five of the ten members named plugins that do
     * not exist.
     */
    it('BuiltInPluginType is gone', () => {
      expect(grep('BuiltInPluginType')).toEqual([]);
    });

    /**
     * Seven MetricType members with no emitter, no analytics query and no
     * chart. `throughput` came with a `createThroughputMetric` factory
     * whose only callers were the entity's own spec, which is how it read
     * as live. A metric type nothing writes shows as zero on any chart
     * built over it, rather than as "not measured".
     */
    it('the seven never-emitted metric types are gone', () => {
      const dead = [
        'ERROR_RATE',
        'THROUGHPUT',
        'CACHE_HIT_RATE',
        'BANDWIDTH_USAGE',
        'CONCURRENT_USERS',
        'API_CALLS',
        'TOOL_EXECUTIONS',
        'createThroughputMetric',
      ];
      expect(grep(dead.join('|'))).toEqual([]);
    });

    it('every surviving MetricType member has an emitter', () => {
      const entity = src('backend/src/entities/usage-metric.entity.ts');
      const block = entity.slice(entity.indexOf('export enum MetricType'));
      const members = [...block.slice(0, block.indexOf('}')).matchAll(/^ {2}([A-Z_]+) =/gm)].map(
        (m) => m[1],
      );
      expect(members.length).toBeGreaterThan(0);

      for (const member of members) {
        // A test-only emitter does not count: that is exactly what made
        // `throughput` look alive for as long as it did.
        const emitters = grep(`MetricType\\.${member}([^A-Za-z0-9_]|$)`).filter(
          (l) =>
            !l.startsWith('backend/src/entities/usage-metric.entity.ts:') &&
            !/\.spec\.ts:/.test(l),
        );
        expect(emitters.length > 0 ? member : `${member} is emitted by nothing`).toBe(member);
      }
    });
  });

  describe('kept and labelled, because wiring them is a product decision', () => {
    /**
     * Conversation.updateStatus. Every conversation is written ACTIVE and
     * nothing transitions it, so completedAt and failureReason are always
     * null and metadata.sessionDuration is never stamped. There is no
     * terminal event to hang it on — a chat has no explicit close, agent
     * runs end without ending their conversation, and the retention sweep
     * deletes by age without reading status. Somebody has to choose the
     * trigger before this has a correct call site.
     */
    it('Conversation.updateStatus is still uncalled, and still says so', () => {
      expect(src('backend/src/entities/conversation.entity.ts')).toContain(
        'NOT IMPLEMENTED beyond creation',
      );
      const callers = grep('updateStatus\\(').filter(
        (l) => !l.startsWith('backend/src/entities/conversation.entity.ts:'),
      );
      // If this fails because somebody wired it: good. Delete this arm
      // and the NOT IMPLEMENTED comment in the entity together.
      expect(callers.filter((l) => /[Cc]onversation/.test(l))).toEqual([]);
    });

    /**
     * Runner.labels. Described as routing labels in the entity and told
     * to users in the same words on the runner detail page, while
     * WorkspaceService.pickRunner takes an explicit runnerId or the
     * account's single runner and never reads the column. Label-based
     * selection is the v1.x scheduler (docs/runner.md says so); until it
     * ships, the copy has to match.
     */
    it('runner labels are not claimed to route, in the entity or the UI', () => {
      expect(src('backend/src/entities/runner.entity.ts')).toContain('NOT USED FOR ROUTING TODAY');
      expect(src('frontend/src/pages/runner-detail.tsx')).toContain(
        'affect where work is dispatched yet',
      );
    });

    it('pickRunner still does not select on labels', () => {
      const source = src('backend/src/modules/workspace/workspace.service.ts');
      const at = source.indexOf('pickRunner');
      expect(at).toBeGreaterThan(-1);
      // When the scheduler ships, this reads labels — and then the copy
      // pinned above is what needs changing, which is why both are here.
      expect(source.slice(at, at + 2000)).not.toContain('.labels');
    });
  });

  describe('the headerMapping left unimplemented is labelled too', () => {
    /**
     * inputMapping and outputMapping are applied by the executor now.
     * headerMapping is not, and unlike those two it has no rename
     * semantics to borrow: outbound headers are assembled per executor
     * under the security policy's allowed-host and HTTPS checks, so
     * honouring it would change what leaves the process.
     */
    it('says so on the column', () => {
      expect(src('backend/src/entities/gateway-tool.entity.ts')).toContain(
        '`headerMapping` is NOT IMPLEMENTED',
      );
    });

    it('and is still read by nothing', () => {
      // The surviving hits may only be the shapes that ACCEPT it — the
      // entity column, the two DTOs, the service field list. Anything
      // else is a reader, and then the label above is the lie.
      const consumers = grep('headerMapping').filter(
        (l) =>
          !l.startsWith('backend/src/entities/gateway-tool.entity.ts:') &&
          !/dto|gateway-tool\.service\.ts|controller/.test(l),
      );
      expect(consumers).toEqual([]);
    });
  });
});
