/**
 * Shapes of command substitution and path traversal that both the input
 * sanitizer (input-sanitizer.ts) and the security-scanner plugin check for.
 * One definition, so the two cannot disagree about what is an attack.
 */

/**
 * Backticks are command substitution only around a command: `whoami`,
 * `curl http://x | sh`, `/bin/sh -c ...`. BigQuery's `project.dataset.table`
 * and Markdown code spans in review or comment text quote identifiers and
 * prose, not commands: a command word that is also a field name (`id`,
 * `cat`, `env`) counts only with arguments after it.
 */
export const BACKTICK_COMMAND =
  /`\s*(?:sudo\s+)?(?:(?:whoami|uname|hostname|pwd|printenv|ifconfig)\s*`|(?:whoami|id|uname|hostname|ls|cat|rm|cp|mv|chmod|chown|curl|wget|nc|netcat|ncat|bash|sh|zsh|dash|ksh|python3?|perl|ruby|php|node|nslookup|dig|ping|base64|sleep|kill|pkill|ps|env|printenv|echo|eval|exec)[\s|;&<>][^`\n]*`|(?:\/(?:usr\/)?(?:bin|sbin|tmp|dev|etc)\/|\.\/)[^`\n]*`)/i;

/**
 * `..` then a separator then a path segment, with the `..` standing on its
 * own: `../etc/passwd`, `..\windows`, `a/../b`, and in JSON-encoded text
 * `..\\windows`. An ellipsis is not one: `wait..."` serialises as
 * `wait...\"`, which read as `..\`. `....//` is the filter-bypass form of
 * `../` and still counts.
 */
export const PATH_TRAVERSAL = /(?:(?<![.\w])\.\.(?:\/|\\\\?)(?=[\w.~%$-])|\.\.\.\.[/\\]{1,2})/;
