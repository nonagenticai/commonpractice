// src/host/mailer.ts — outbound transactional mail.
//
// CP had NO mailer before this: the only email in the whole system was Keycloak's own
// `execute-actions-email` (the magic link), which can send Keycloak's action emails and nothing
// else. The budget-threshold alerts need real transactional mail addressed to a tenant's admins.
//
// DEFAULT OFF (`config.mail.enabled`), following the auditExport / metering / translation
// convention: dev, CI and `bun test` never open a socket, and prod opts in via gitops. When
// disabled — or when a send fails — `sendMail` returns false instead of throwing, because email is
// a SECONDARY channel here: the in-app notification is the primary one and must not be lost
// because an SMTP relay is unreachable.
//
// The transport is created lazily and reused (nodemailer pools the connection), and every send is
// bounded by config.mail.timeoutMs so a hung relay can never stall a scheduler tick.
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config';
import { log } from './logger';

export interface MailMessage {
  to: string | string[];
  subject: string;
  /** Plain-text body. Always sent — some recipients/filters never render the HTML part. */
  text: string;
  /** Optional HTML alternative. */
  html?: string;
}

let transport: Transporter | undefined;

function getTransport(): Transporter {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      // `secure` = implicit TLS (465). For 587 we connect in plaintext and upgrade via STARTTLS,
      // which `requireTLS` makes mandatory rather than opportunistic — an relay that silently
      // refuses the upgrade must fail, not send credentials in the clear.
      secure: !config.mail.starttls,
      requireTLS: config.mail.starttls,
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.password } : undefined,
      connectionTimeout: config.mail.timeoutMs,
      greetingTimeout: config.mail.timeoutMs,
      socketTimeout: config.mail.timeoutMs,
    });
  }
  return transport;
}

/** Test seam (house pattern): inject a fake transport, `(undefined)` to restore. */
export function __setMailTransportForTests(fake: Transporter | undefined): void {
  transport = fake;
}

/** True when mail is configured well enough to attempt a send. */
export function mailEnabled(): boolean {
  return config.mail.enabled && Boolean(config.mail.host && config.mail.from);
}

/**
 * Best-effort send. Returns true when the relay accepted the message.
 *
 * NEVER throws: the caller (the budget scheduler) has already persisted the in-app notification by
 * the time it gets here, and losing a whole tick because a relay is down would be worse than
 * losing one email. Failures are logged with the recipient so they are diagnosable.
 */
export async function sendMail(msg: MailMessage): Promise<boolean> {
  if (!mailEnabled()) {
    log.info('mail_disabled_skipping', { component: 'mail', subject: msg.subject, to: msg.to });
    return false;
  }
  try {
    await getTransport().sendMail({
      from: config.mail.fromName
        ? `"${config.mail.fromName}" <${config.mail.from}>`
        : config.mail.from,
      to: Array.isArray(msg.to) ? msg.to.join(', ') : msg.to,
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
    });
    return true;
  } catch (err) {
    log.error('mail_send_failed', { component: 'mail', subject: msg.subject, to: msg.to, err });
    return false;
  }
}
