import { operatorMessage } from '../app-build.processor';

/**
 * What a failed build tells the person who pressed Build.
 *
 * A Node error arrives as a sentence followed by a require stack of
 * absolute paths. The stack belongs in the build log; the panel gets
 * the sentence, with the host's filesystem left out of it.
 */
describe('operatorMessage', () => {
  it('keeps the sentence and drops the require stack under it', () => {
    const err = new Error(
      "Cannot find module '@almyty/chat/dist/index.js'\nRequire stack:\n- /srv/app/dist/main.js",
    );
    // The specifier names the missing dependency and describes no host,
    // so it survives; the stack of absolute paths under it does not.
    expect(operatorMessage(err)).toBe("Cannot find module '@almyty/chat/dist/index.js'");
  });

  it('replaces an absolute path that stands on its own', () => {
    expect(operatorMessage(new Error('cannot write /srv/app/out.bin'))).toBe(
      'cannot write <path>',
    );
  });

  it('does not describe the build host to whoever can see the panel', () => {
    const err = new Error('ENOENT: no such file, open /Users/frane/workspace/almyty/backend/x.ts');
    const message = operatorMessage(err);
    expect(message).not.toContain('/Users/frane');
    expect(message).toContain('ENOENT');
  });

  it('replaces a windows path too', () => {
    const err = new Error('failed reading C:\\builds\\almyty\\out.exe');
    expect(operatorMessage(err)).not.toContain('C:\\builds');
  });

  it('leaves a message that names no path alone', () => {
    expect(operatorMessage(new Error('bun exited with code 1.'))).toBe('bun exited with code 1.');
  });

  it('says something rather than nothing when the error is empty', () => {
    expect(operatorMessage(new Error(''))).toBe('The build failed.');
    expect(operatorMessage(undefined)).toBe('The build failed.');
  });

  it('caps the length, so one line cannot fill the panel', () => {
    expect(operatorMessage(new Error('x'.repeat(2000))).length).toBe(500);
  });
})
