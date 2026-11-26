import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORT,
  loadConfig,
  parseDebug,
  parsePort,
  passwordEnvName,
} from '../../src/config/load.js';
import { MailError } from '../../src/errors.js';

const VALID = `
owner: alex
accounts:
  - id: personal
    address: personal@example.com
    provider: gmail
    level: send
    signature: |
      Cheers
  - id: work-box
    address: info@example.org
    username: info
    provider: imap
    imap: { host: mail.example.org, port: 993 }
    smtp: { host: mail.example.org, port: 465 }
    level: draft
    mailboxes: { junk: Spam }
`;

const ENV = { MAILMCP_PASSWORD_PERSONAL: 'p1', MAILMCP_PASSWORD_WORK_BOX: 'p2' };

function expectConfigError(run: () => void, fragment: string): void {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(MailError);
    if (err instanceof MailError) {
      expect(err.code).toBe('config_invalid');
      expect(err.message).toContain(fragment);
    }
    return;
  }
  throw new Error('expected loadConfig to throw');
}

describe('passwordEnvName', () => {
  it('upper-cases the id and replaces dashes', () => {
    expect(passwordEnvName('work-box')).toBe('MAILMCP_PASSWORD_WORK_BOX');
  });
});

describe('parsePort', () => {
  it('defaults when unset and accepts a valid port', () => {
    expect(parsePort(undefined)).toBe(DEFAULT_PORT);
    expect(parsePort('9000')).toBe(9000);
  });

  it('rejects anything but an integer from 1 to 65535', () => {
    for (const bad of ['', 'abc', '0', '65536', '80.5', ' 80', '-1']) {
      expectConfigError(() => parsePort(bad), 'MAILMCP_PORT');
    }
  });
});

describe('parseDebug', () => {
  it('is off when unset or 0 and on for 1', () => {
    expect(parseDebug(undefined)).toBe(false);
    expect(parseDebug('0')).toBe(false);
    expect(parseDebug('1')).toBe(true);
  });

  it('rejects anything else', () => {
    for (const bad of ['yes', '', 'true', '2', ' 1']) {
      expectConfigError(() => parseDebug(bad), 'MAILMCP_DEBUG');
    }
  });
});

describe('loadConfig', () => {
  it('loads an archive mailbox override', () => {
    const yaml = VALID.replace('{ junk: Spam }', '{ archive: Archive }');
    expect(loadConfig(yaml, ENV).accounts[1]?.mailboxes.archive).toBe('Archive');
  });

  it('fills Gmail endpoints and defaults the username to the address', () => {
    const config = loadConfig(VALID, ENV);
    const personal = config.accounts[0];
    expect(personal?.imap).toEqual({ host: 'imap.gmail.com', port: 993 });
    expect(personal?.smtp).toEqual({ host: 'smtp.gmail.com', port: 465 });
    expect(personal?.username).toBe('personal@example.com');
    expect(personal).not.toHaveProperty('password');
    expect(JSON.stringify(config.accounts)).not.toContain('p1');
    expect(personal?.owner).toBe('alex');
    expect(personal?.signature).toBe('Cheers\n');
  });

  it('keeps passwords in a lookup apart from the accounts', () => {
    const config = loadConfig(VALID, ENV);
    expect(config.passwordFor('personal')).toBe('p1');
    expect(config.passwordFor('work-box')).toBe('p2');
    expect(() => config.passwordFor('nope')).toThrow('nope');
  });

  it('keeps explicit IMAP settings, username and mailbox overrides', () => {
    const work = loadConfig(VALID, ENV).accounts[1];
    expect(work?.imap).toEqual({ host: 'mail.example.org', port: 993 });
    expect(work?.username).toBe('info');
    expect(work?.mailboxes).toEqual({ junk: 'Spam' });
    expect(work?.level).toBe('draft');
  });

  it('names the missing password variable', () => {
    expectConfigError(
      () => loadConfig(VALID, { MAILMCP_PASSWORD_PERSONAL: 'p1' }),
      'MAILMCP_PASSWORD_WORK_BOX',
    );
  });

  it('treats an empty password as missing', () => {
    expectConfigError(
      () => loadConfig(VALID, { ...ENV, MAILMCP_PASSWORD_PERSONAL: '' }),
      'MAILMCP_PASSWORD_PERSONAL',
    );
  });

  it('rejects duplicate ids', () => {
    const yaml = `
owner: alex
accounts:
  - { id: a, address: a@example.com, provider: gmail, level: read }
  - { id: a, address: b@example.com, provider: gmail, level: read }
`;
    expectConfigError(
      () => loadConfig(yaml, { MAILMCP_PASSWORD_A: 'x' }),
      'duplicate account id "a"',
    );
  });

  it('rejects an id that cannot be used in a URL', () => {
    const yaml = `
owner: alex
accounts:
  - { id: Work_Box, address: a@example.com, provider: gmail, level: read }
`;
    expectConfigError(() => loadConfig(yaml, {}), 'id');
  });

  it('rejects unknown keys', () => {
    const yaml = `
owner: alex
accounts:
  - { id: a, address: a@example.com, provider: gmail, level: read, tls: false }
`;
    expectConfigError(() => loadConfig(yaml, { MAILMCP_PASSWORD_A: 'x' }), 'tls');
  });

  it('requires imap and smtp for generic IMAP accounts', () => {
    const yaml = `
owner: alex
accounts:
  - { id: a, address: a@example.org, provider: imap, level: read }
`;
    expectConfigError(() => loadConfig(yaml, { MAILMCP_PASSWORD_A: 'x' }), 'imap');
  });

  it('reports YAML syntax errors as config errors', () => {
    expectConfigError(() => loadConfig('owner: [unclosed', {}), 'accounts.yaml');
  });

  it('names the YAML error position without echoing the config line', () => {
    const yaml = 'owner: alex\naccounts:\n  - id: a\n    address: [secret@example.org\n';
    expectConfigError(() => loadConfig(yaml, {}), 'line 5, column 1');
    try {
      loadConfig(yaml, {});
    } catch (err) {
      expect(err instanceof Error ? err.message : '').not.toContain('secret');
    }
  });
});
