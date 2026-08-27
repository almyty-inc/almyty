import { handoffFor } from '../build-handoff';

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
      const desktop = handoffFor('macos-arm64', false, 'Acme Assistant');
      expect(desktop.command).toContain('/Applications/Acme Assistant.app');
    });

    it('makes the filename safe for a shell', () => {
      // The product name comes from a form field and ends up in a
      // command someone pastes into a terminal.
      const handoff = handoffFor('macos-arm64', false, 'Acme Assistant');
      expect(handoff.command).not.toMatch(/[;&|$`]/);
    });

    it('mentions the right-click alternative for a bundle', () => {
      // Not everyone will open a terminal.
      expect(handoffFor('macos-arm64', false, 'Acme').summary).toMatch(/right-click/i);
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
