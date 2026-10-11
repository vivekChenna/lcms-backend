import { IsNull, type DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { PasswordLink, type PasswordLinkPurpose } from './entities/password-link.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { generateOpaqueToken, hashToken } from './auth.service';
import { logAuditEvent } from '../audit/audit.service';
import { setRequestUser } from '../../db/request-context';
import { hashPassword } from '../../shared/password';
import { ServiceUnavailableError, ValidationError } from '../../shared/errors';
import type { Mailer } from '../notifications/email/mailer';

/** How long an emailed link works. Keep the email text in step with this. */
export const PASSWORD_LINK_TTL_HOURS = 48;

export const INVALID_LINK_MESSAGE = 'This link is no longer valid. Ask for a new one.';

export type PasswordLinkDeps = {
  dataSource: DataSource;
  /** null when email is not configured: links cannot be delivered, and callers are told so. */
  mailer: Mailer | null;
  /** Public address of the frontend; links point at `${frontendUrl}/set-password`. */
  frontendUrl: string | undefined;
};

type AuditAs = { actorId: string; action: string };

function emailFor(name: string, purpose: PasswordLinkPurpose, link: string): { subject: string; text: string } {
  const common = [
    link,
    '',
    `This link works once and expires in ${PASSWORD_LINK_TTL_HOURS} hours. If you were not expecting this email, you can ignore it: nothing changes until the link is used.`,
  ];
  if (purpose === 'invite') {
    return {
      subject: 'Set your password for Algihaz LCMS',
      text: [
        `Hello ${name},`,
        '',
        'An account has been created for you on the Algihaz Legal Case Management System.',
        'Choose your password here:',
        '',
        ...common,
      ].join('\n'),
    };
  }
  return {
    subject: 'Reset your password for Algihaz LCMS',
    text: [`Hello ${name},`, '', 'Use this link to choose a new password for your Algihaz LCMS account:', '', ...common].join('\n'),
  };
}

/**
 * Creates a fresh one-time link for the user (cancelling any older live one) and emails it.
 * Never throws for a delivery problem: it returns whether the email went out, because the account
 * itself is already in the right state either way. An audit entry is written in both cases.
 */
export async function sendPasswordLink(
  deps: PasswordLinkDeps,
  user: User,
  purpose: PasswordLinkPurpose,
  audit: AuditAs,
): Promise<boolean> {
  const { dataSource, mailer, frontendUrl } = deps;
  let emailSent = false;
  if (mailer && frontendUrl) {
    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + PASSWORD_LINK_TTL_HOURS * 60 * 60 * 1000);
    await dataSource.transaction(async (manager) => {
      await manager
        .getRepository(PasswordLink)
        .update({ userId: user.id, consumedAt: IsNull() }, { consumedAt: new Date() });
      const repo = manager.getRepository(PasswordLink);
      await repo.save(repo.create({ userId: user.id, tokenHash: hashToken(token), purpose, expiresAt }));
    });
    try {
      const link = `${frontendUrl.replace(/\/+$/, '')}/set-password?token=${token}`;
      await mailer.send({ to: user.email, ...emailFor(user.fullName, purpose, link) });
      emailSent = true;
    } catch {
      emailSent = false;
    }
  }
  // the audit row names this person as the actor; the database must let them see their own entry
  setRequestUser(audit.actorId);
  await logAuditEvent(dataSource, {
    actorId: audit.actorId,
    action: audit.action,
    afterValue: { userId: user.id, email: user.email, purpose, emailSent },
  });
  return emailSent;
}

/** Admin action: email an active user a link. Fails loudly, so the admin knows it did not arrive. */
export async function sendPasswordLinkAsAdmin(deps: PasswordLinkDeps, adminId: string, user: User): Promise<void> {
  const purpose: PasswordLinkPurpose = user.passwordHash ? 'reset' : 'invite';
  const sent = await sendPasswordLink(deps, user, purpose, { actorId: adminId, action: 'user.password_link_sent' });
  if (!sent) {
    throw new ServiceUnavailableError('The email could not be sent. Check the mail settings and try again.');
  }
}

/**
 * "Forgot password": always succeeds from the caller's point of view, whether or not the address
 * belongs to an account, so it cannot be used to find out who has one. Only active accounts get mail.
 */
export async function requestPasswordLink(deps: PasswordLinkDeps, email: string): Promise<void> {
  const user = await deps.dataSource.getRepository(User).findOne({ where: { email: email.toLowerCase() } });
  if (!user || !user.isActive) return;
  const purpose: PasswordLinkPurpose = user.passwordHash ? 'reset' : 'invite';
  await sendPasswordLink(deps, user, purpose, { actorId: user.id, action: 'user.password_link_requested' });
}

/**
 * Spends a link to set the user's password. The claim, the new password, the sign-out of every
 * existing session and the audit entry happen in one transaction, so a failure part-way leaves the
 * link usable; and the claim is a single UPDATE, so of any number of simultaneous attempts exactly
 * one wins.
 */
export async function setPasswordWithToken(dataSource: DataSource, token: string, newPassword: string): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  await dataSource.transaction(async (manager) => {
    const [claimed] = (await manager.query(
      `UPDATE password_links SET "consumedAt" = now()
       WHERE "tokenHash" = $1 AND "consumedAt" IS NULL AND "expiresAt" > now()
       RETURNING "userId", "purpose"`,
      [hashToken(token)],
    )) as [Array<{ userId: string; purpose: PasswordLinkPurpose }>, number];
    const link = claimed[0];
    if (claimed.length !== 1 || !link) {
      throw new ValidationError(INVALID_LINK_MESSAGE);
    }
    const user = await manager.getRepository(User).findOne({ where: { id: link.userId } });
    // a deactivated account stays deactivated: a link must not bring it back
    if (!user || !user.isActive) {
      throw new ValidationError(INVALID_LINK_MESSAGE);
    }
    await manager.getRepository(User).update({ id: user.id }, { passwordHash });
    await manager.getRepository(RefreshToken).update({ userId: user.id, revokedAt: IsNull() }, { revokedAt: new Date() });
    // the one-time link proved who this is; the audit row names them as the actor
    // (this transaction already holds a connection, so tell the database now as well as the context)
    setRequestUser(user.id);
    await manager.query(`SELECT set_config('app.user_id', $1, true)`, [user.id]);
    await logAuditEvent(manager, {
      actorId: user.id,
      action: 'user.password_set',
      afterValue: { userId: user.id, email: user.email, purpose: link.purpose },
    });
  });
}
