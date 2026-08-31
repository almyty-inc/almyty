import { downloadedFilename, handoffFor, shellQuote } from '../build-handoff';

/**
 * What a recipient is told.
 *
 * Unsigned is a legitimate way to ship, especially inside a company
 * where a Developer ID is weeks of someone else's paperwork. Handing
 * someone a download that refuses to open and letting them work out why
 * is not.
 */
describe('handoffFor', () => {
  describe('Linux', () => {
    it('has nothing to say, because there is nothing to do', () => {
      const handoff = handoffFor('linux-x64', false);
      expect(handoff.summary).toMatch(/nothing to do/i);
      expect(handoff.command).toBeNull();
    });

    it('says the same whether or not it was signed', () => {
      expect(handoffFor('linux-x64', true)).toEqual(handoffFor('linux-x64', false));
    });
  });

  describe('Windows', () => {
    it('names the two clicks that get past SmartScreen', () => {
      const handoff = handoffFor('windows-x64', false);
      expect(handoff.summary).toContain('More info');
      expect(handoff.summary).toContain('Run anyway');
    });

    it('does not invent a command, because there is not one', () => {
      // Better to say so than to leave someone looking for it.
      const handoff = handoffFor('windows-x64', false);
      expect(handoff.command).toBeNull();
      expect(handoff.summary).toMatch(/no command/i);
    });
  });

  describe('macOS', () => {
    it('gives the command that clears the quarantine flag', () => {
      const handoff = handoffFor('macos-arm64', false, 'Acme Assistant');
      expect(handoff.command).toContain('xattr');
      expect(handoff.command).toContain('com.apple.quarantine');
    });

    it('says what the command does, so nobody runs it blind', () => {
      const handoff = handoffFor('macos-arm64', false);
      expect(handoff.commandNote).toMatch(/quarantine/i);
      expect(handoff.commandNote).toMatch(/origin/i);
    });

    it('points a bundle at Applications and a bare executable at the file', () => {
      // A .app is installed; a terminal binary is run where it lands.
      // The platform is the same for both, so this is read off what was
      // actually produced rather than off the platform table.
      const desktop = handoffFor('macos-arm64', false, 'Acme Assistant', 'acme-1.0.0-macos.zip');
      expect(desktop.command).toContain('/Applications/Acme Assistant.app');

      const terminal = handoffFor('macos-arm64', false, 'Acme Assistant', 'acme-1.0.0-macos');
      expect(terminal.command).toContain('acme-1.0.0-macos');
      expect(terminal.command).not.toContain('Applications');
    });

    it('names the file that was actually downloaded', () => {
      // A command naming a file that is not there is worse than no
      // command: the recipient assumes they did something wrong.
      const handoff = handoffFor('macos-arm64', false, 'Acme', 'acme-1.2.0-macos-arm64');
      expect(handoff.command).toContain('acme-1.2.0-macos-arm64');
    });

    it('cannot be talked into running something else', () => {
      // The product name is a form field, and this command is pasted
      // into a terminal by an operator or by whoever they ship to.
      const handoff = handoffFor(
        'macos-arm64',
        false,
        'Acme" ; rm -rf ~ ; echo "',
        'acme-1.0.0-macos.zip',
      );

      // Everything after the tool name is one quoted argument.
      const argument = handoff.command!.replace('xattr -dr com.apple.quarantine ', '');
      expect(argument.startsWith("'")).toBe(true);
      expect(argument.endsWith("'")).toBe(true);
      // The only unescaped quotes are the outer pair.
      expect(argument.slice(1, -1).replace(/'\\''/g, '')).not.toContain("'");
    });

    it('mentions the right-click alternative for a bundle', () => {
      // Not everyone will open a terminal.
      expect(
        handoffFor('macos-arm64', false, 'Acme', 'acme-1.0.0-macos.zip').summary,
      ).toMatch(/right-click/i);
    });
  });

  describe('signed', () => {
    it('has nothing to hand over once it is signed', () => {
      // Which is the point of signing, and worth saying.
      const handoff = handoffFor('macos-arm64', true, 'Acme Assistant');
      expect(handoff.command).toBeNull();
      expect(handoff.summary).toContain('without a warning');
      expect(handoff.summary).toContain('Acme Assistant');
    });

    it('says the same for Windows', () => {
      expect(handoffFor('windows-x64', true).command).toBeNull();
    });
  });

  it('does not throw on a platform it does not know', () => {
    expect(handoffFor('solaris-sparc', false)).toMatchObject({ command: null });
  });
});

describe('shellQuote', () => {
  it('wraps an ordinary value in single quotes', () => {
    expect(shellQuote('/Applications/Acme.app')).toBe("'/Applications/Acme.app'");
  });

  it('survives a name containing a double quote', () => {
    // Double quotes are literal inside single quotes.
    expect(shellQuote('Acme" ; rm -rf ~')).toBe(`'Acme" ; rm -rf ~'`);
  });

  it('closes, escapes and reopens around a single quote', () => {
    // The one character single quoting cannot contain.
    expect(shellQuote("Ava's App")).toBe(`'Ava'\\''s App'`);
  });

  it('leaves shell metacharacters inert', () => {
    for (const value of ['$(whoami)', '`id`', 'a; b', 'a && b', 'a | b']) {
      expect(shellQuote(value)).toBe(`'${value}'`);
    }
  });
});

describe('downloadedFilename', () => {
  it('names the product, the version and the platform', () => {
    expect(downloadedFilename('acme', '1.2.0', 'linux-x64', 'k/abc.AppImage')).toBe(
      'acme-1.2.0-linux-x64.AppImage',
    );
  });

  it('omits an extension the artifact does not have', () => {
    // A bare unix executable has none, and a trailing dot is not a name.
    expect(downloadedFilename('acme', '1.0.0', 'macos-arm64', 'k/abc')).toBe(
      'acme-1.0.0-macos-arm64',
    );
  });

  it('falls back rather than writing "null" into a filename', () => {
    expect(downloadedFilename('acme', null, 'linux-x64', null)).toBe('acme-0.0.0-linux-x64');
  });
});
