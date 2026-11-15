// tests/mailer.test.ts — outbound transactional mail (host/mailer.ts).
//
// Email is the SECONDARY channel for budget alerts (the in-app notification is primary), so the
// contract that matters is: never throw, never send when disabled, and always carry a plain-text
// part. A mailer that threw would take down a whole scheduler tick over one unreachable relay.
import { afterEach, expect, test } from 'bun:test';
import type { Transporter } from 'nodemailer';
import { __setMailTransportForTests, mailEnabled, sendMail } from '../src/host/mailer';
import { config } from '../src/config';

type MailCfg = { enabled: boolean; host: string; from: string; fromName: string };
const cfg = config.mail as unknown as MailCfg;
const original = { ...cfg };

function fakeTransport(opts: { throws?: Error } = {}) {
  const sent: Record<string, unknown>[] = [];
  const transport = {
    sendMail: async (msg: Record<string, unknown>) => {
      if (opts.throws) throw opts.throws;
      sent.push(msg);
      return { messageId: 'fake' };
    },
  } as unknown as Transporter;
  return { transport, sent };
}

function enable() {
  cfg.enabled = true;
  cfg.host = 'smtp.test';
  cfg.from = 'noreply@cp.test';
  cfg.fromName = 'Common Practice';
}

afterEach(() => {
  Object.assign(cfg, original);
  __setMailTransportForTests(undefined);
});

test('mail is OFF by default so dev / CI / bun test never open a socket', () => {
  Object.assign(cfg, original);
  expect(config.mail.enabled).toBe(false);
  expect(mailEnabled()).toBe(false);
});

test('a disabled mailer returns false without touching the transport', async () => {
  const { transport, sent } = fakeTransport();
  __setMailTransportForTests(transport);
  cfg.enabled = false;
  expect(await sendMail({ to: 'a@b.c', subject: 's', text: 't' })).toBe(false);
  expect(sent.length).toBe(0);
});

test('enabled-but-unconfigured (no host / no from) does not attempt a send', async () => {
  const { transport, sent } = fakeTransport();
  __setMailTransportForTests(transport);
  cfg.enabled = true;
  cfg.host = '';
  cfg.from = '';
  expect(mailEnabled()).toBe(false);
  expect(await sendMail({ to: 'a@b.c', subject: 's', text: 't' })).toBe(false);
  expect(sent.length).toBe(0);
});

test('a configured send carries the from-name, the recipients and a text part', async () => {
  enable();
  const { transport, sent } = fakeTransport();
  __setMailTransportForTests(transport);

  expect(
    await sendMail({
      to: ['admin1@acme.test', 'admin2@acme.test'],
      subject: '[Acme] 90% of your budget is used',
      text: 'Add your own key.',
    }),
  ).toBe(true);

  expect(sent.length).toBe(1);
  expect(sent[0]!.from).toBe('"Common Practice" <noreply@cp.test>');
  // Multiple admins arrive as one comma-joined header, not as N separate sends.
  expect(sent[0]!.to).toBe('admin1@acme.test, admin2@acme.test');
  expect(sent[0]!.subject).toContain('90%');
  expect(sent[0]!.text).toBe('Add your own key.');
  // No html part was supplied, so none is sent (rather than an empty string).
  expect('html' in sent[0]!).toBe(false);
});

test('a relay failure returns false and NEVER throws — the alert tick must survive it', async () => {
  enable();
  const { transport } = fakeTransport({ throws: new Error('ECONNREFUSED smtp.test:587') });
  __setMailTransportForTests(transport);
  expect(await sendMail({ to: 'a@b.c', subject: 's', text: 't' })).toBe(false);
});

test('an html alternative is included when given', async () => {
  enable();
  const { transport, sent } = fakeTransport();
  __setMailTransportForTests(transport);
  await sendMail({ to: 'a@b.c', subject: 's', text: 'plain', html: '<p>rich</p>' });
  expect(sent[0]!.html).toBe('<p>rich</p>');
  expect(sent[0]!.text).toBe('plain'); // text always present — some clients never render html
});
