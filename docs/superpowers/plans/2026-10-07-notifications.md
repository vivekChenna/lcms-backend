# Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver every BRD-required notification (NT-01..05, AU-13) as both an in-app notification with read/unread state and an email sent by a durable, retrying queue, and add the notification calls to the existing case and information-request actions.

**Architecture:** A new `src/modules/notifications/` module owns one `notifications` table whose rows are both the in-app item and the email queue entry (`emailStatus`, attempts, next-attempt time). Per-event helper functions in `notifications.events.ts` resolve recipients and insert rows using whatever `DataSource | EntityManager` the caller holds; `cases` and `information-requests` services call them the same way they call `logAuditEvent`. An in-process worker started only by `server.ts` sends pending emails through a `Mailer` interface (Nodemailer SMTP in production, a recording fake in tests).

**Tech Stack:** Fastify 5, TypeORM, PostgreSQL, Zod 4 + fastify-type-provider-zod, `nodemailer`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-07-notifications-design.md`

## Global Constraints

- **Commit messages must NOT contain a `Co-Authored-By` trailer or any Claude/Anthropic attribution line.** The project owner has asked for this repeatedly. Write commit messages as plain text exactly as shown in each task's commit step.
- Schema changes only via committed migrations — never `synchronize: true`.
- Work on `main`, one commit per task (code + tests + decision files together). Do not push. Never stage `.archify/`, `CLAUDE.md`, `Algihaz-LCMS-Database-Schema.docx`, `Timesheet_Sep-Oct_Algihaz_Vivek.xlsx`.
- Recipients (spec §4): case registered → submitting requester; case assigned → the new assignee then the submitting requester; case accepted → submitting requester; assignment rejected → all active `legal_manager` users (body includes the written reason); case closed → submitting requester; information request raised → the responder then the submitting requester; information request answered → the case's assigned rep (nobody if none); information request reopened → the responder; SLA breached → all active `legal_manager` users.
- A user receives at most one notification per event (recipients are taken in the order listed above; the first match supplies the text). Inactive users never receive notifications. A missing recipient (e.g. no assigned rep) is skipped silently — a helper never throws because a recipient is absent.
- Notification text is plain text built from the case reference number and case title (plus the rejection reason). It never contains the case description, document names/contents, comment text, information-request subject or reopen comment. The notification `title` (also the email subject) is always a single line of at most 200 characters.
- Email delivery: each row is claimed in its own short transaction with `FOR UPDATE SKIP LOCKED`; success → `sent`; failure → `emailAttempts += 1` and the retry delay after the 1st, 2nd, 3rd, 4th failure is 1, 5, 15, 60 minutes; the 5th failure → `failed`; an inactive recipient → `failed` with `emailLastError = 'recipient inactive'` and no send. In-app notifications never depend on email success. The worker is started only by `server.ts`, never by `buildApp`.
- Time comparisons for the email queue use the database clock (`now()`), never the Node clock, so test and production behave identically regardless of host/container clock drift.
- No audit entry is written for creating or reading a notification.
- Test files must use `resetDatabase(ds)` from `test/integration/helpers/reset-db.ts` per test and seed fixture users per test (never once in `beforeAll`).
- Every route returning a `Date` through a Zod `z.string()` schema must convert at the route boundary (`.toISOString()`).
- TDD: write the failing test before the implementation, for every task.

## Review Focus

- A case title containing newlines, quotes or non-ASCII characters must never produce a multi-line email subject (the subject is built from the reference number only) and must appear unmangled in the body. Pinned in Task 3.
- A very long case title must not break notification creation (title is capped, body keeps the full case title). Pinned in Task 3.
- When the requester and the assignee (or the requester and the responder) are the same person, they get exactly one notification for that event. Pinned in Tasks 3, 5 and 6.
- A case that is assigned, rejected and then reassigned must notify the right people each time (the second assignee gets one assignment notification; the first assignee gets nothing new). Pinned in Task 5.
- A user deactivated after their notification was created must not be emailed, and one mail-server failure must not affect other users' emails or any in-app notification. Pinned in Task 8.

---

### Task 1: SMTP config, mailer, recording fake, `.env.example`

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml` (via `pnpm add`)
- Modify: `src/config/env.ts`
- Create: `src/modules/notifications/email/mailer.ts`
- Create: `src/modules/notifications/email/nodemailer-mailer.ts`
- Modify: `.env.example` (it exists and is tracked — append the block shown)
- Create: `test/integration/helpers/recording-mailer.ts`
- Test: `test/unit/config/env-smtp.test.ts`
- Test: `test/unit/modules/notifications/nodemailer-mailer.test.ts`
- Test: `test/unit/helpers/recording-mailer.test.ts`
- Test: `test/integration/email/mailhog.smoke.test.ts`

**Interfaces:**
- Produces: `type MailMessage = { to: string; subject: string; text: string }`; `interface Mailer { send(message: MailMessage): Promise<void> }`; `class NodemailerMailer implements Mailer` (constructor `(transporter: Transporter, from: string)`); `createMailerFromEnv(env: Env): NodemailerMailer` (throws if `SMTP_HOST` or `MAIL_FROM` is missing); `Env` gains `SMTP_HOST?`, `SMTP_PORT: number` (default 1025), `SMTP_SECURE: boolean` (default false), `SMTP_USER?`, `SMTP_PASSWORD?`, `MAIL_FROM?`; test helper `RecordingMailer` with `sent: MailMessage[]`, `maxInFlight: number`, `failNext(count)`, `failAlways()`, `setDelay(ms)`.

- [ ] **Step 1: Install the packages**

Run: `pnpm add nodemailer` then `pnpm add -D @types/nodemailer`
Expected: `nodemailer` appears under `dependencies` and `@types/nodemailer` under `devDependencies` in `package.json`. Run `pnpm ls nodemailer @types/nodemailer` and confirm both resolve.

- [ ] **Step 2: Write the failing tests**

```typescript
// test/unit/config/env-smtp.test.ts
import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../../src/config/env';

const base = { DATABASE_URL: 'postgres://x', JWT_ACCESS_SECRET: 'x'.repeat(32) };

describe('SMTP env settings', () => {
  it('defaults the port and secure flag and leaves host, credentials and sender optional', () => {
    const env = loadEnv({ ...base });
    expect(env.SMTP_PORT).toBe(1025);
    expect(env.SMTP_SECURE).toBe(false);
    expect(env.SMTP_HOST).toBeUndefined();
    expect(env.SMTP_USER).toBeUndefined();
    expect(env.SMTP_PASSWORD).toBeUndefined();
    expect(env.MAIL_FROM).toBeUndefined();
  });

  it('parses explicit SMTP settings', () => {
    const env = loadEnv({
      ...base,
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_SECURE: 'true',
      SMTP_USER: 'mailer',
      SMTP_PASSWORD: 'secret',
      MAIL_FROM: 'lcms@algihaz.example',
    });
    expect(env.SMTP_HOST).toBe('smtp.example.com');
    expect(env.SMTP_PORT).toBe(587);
    expect(env.SMTP_SECURE).toBe(true);
    expect(env.SMTP_USER).toBe('mailer');
    expect(env.MAIL_FROM).toBe('lcms@algihaz.example');
  });
});
```

```typescript
// test/unit/modules/notifications/nodemailer-mailer.test.ts
import { describe, it, expect, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { NodemailerMailer, createMailerFromEnv } from '../../../../src/modules/notifications/email/nodemailer-mailer';
import { loadEnv } from '../../../../src/config/env';

const base = { DATABASE_URL: 'postgres://x', JWT_ACCESS_SECRET: 'x'.repeat(32) };

describe('NodemailerMailer', () => {
  it('sends the message with the configured sender', async () => {
    const transporter = nodemailer.createTransport({ jsonTransport: true });
    const sendMail = vi.spyOn(transporter, 'sendMail').mockResolvedValue({} as never);
    const mailer = new NodemailerMailer(transporter, 'lcms@algihaz.example');

    await mailer.send({ to: 'user@algihaz.example', subject: 'Subject line', text: 'Body text' });

    expect(sendMail).toHaveBeenCalledWith({
      from: 'lcms@algihaz.example',
      to: 'user@algihaz.example',
      subject: 'Subject line',
      text: 'Body text',
    });
  });

  it('propagates a transport failure so the dispatcher can retry', async () => {
    const transporter = nodemailer.createTransport({ jsonTransport: true });
    vi.spyOn(transporter, 'sendMail').mockRejectedValue(new Error('connection refused'));
    const mailer = new NodemailerMailer(transporter, 'lcms@algihaz.example');

    await expect(mailer.send({ to: 'a@b.c', subject: 's', text: 't' })).rejects.toThrow('connection refused');
  });
});

describe('createMailerFromEnv', () => {
  it('refuses to start without SMTP_HOST or MAIL_FROM', () => {
    expect(() => createMailerFromEnv(loadEnv({ ...base, MAIL_FROM: 'a@b.c' }))).toThrow(/SMTP_HOST and MAIL_FROM/);
    expect(() => createMailerFromEnv(loadEnv({ ...base, SMTP_HOST: 'localhost' }))).toThrow(/SMTP_HOST and MAIL_FROM/);
  });

  it('builds a mailer when both are present', () => {
    const mailer = createMailerFromEnv(loadEnv({ ...base, SMTP_HOST: 'localhost', MAIL_FROM: 'a@b.c' }));
    expect(mailer).toBeInstanceOf(NodemailerMailer);
  });
});
```

```typescript
// test/unit/helpers/recording-mailer.test.ts
import { describe, it, expect } from 'vitest';
import { RecordingMailer } from '../../integration/helpers/recording-mailer';

const message = (subject: string) => ({ to: 'a@b.c', subject, text: 't' });

describe('RecordingMailer', () => {
  it('records sent messages in order', async () => {
    const mailer = new RecordingMailer();
    await mailer.send(message('one'));
    await mailer.send(message('two'));
    expect(mailer.sent.map((m) => m.subject)).toEqual(['one', 'two']);
  });

  it('fails the next N sends and then recovers', async () => {
    const mailer = new RecordingMailer();
    mailer.failNext(2);
    await expect(mailer.send(message('a'))).rejects.toThrow('SMTP unavailable');
    await expect(mailer.send(message('b'))).rejects.toThrow('SMTP unavailable');
    await mailer.send(message('c'));
    expect(mailer.sent.map((m) => m.subject)).toEqual(['c']);
  });

  it('can fail forever', async () => {
    const mailer = new RecordingMailer();
    mailer.failAlways();
    await expect(mailer.send(message('a'))).rejects.toThrow('SMTP unavailable');
    await expect(mailer.send(message('b'))).rejects.toThrow('SMTP unavailable');
    expect(mailer.sent).toHaveLength(0);
  });

  it('tracks the highest number of overlapping sends when a delay is set', async () => {
    const mailer = new RecordingMailer();
    mailer.setDelay(30);
    await Promise.all([mailer.send(message('a')), mailer.send(message('b'))]);
    expect(mailer.maxInFlight).toBe(2);
    expect(mailer.sent).toHaveLength(2);
  });
});
```

```typescript
// test/integration/email/mailhog.smoke.test.ts
import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../../src/config/env';
import { createMailerFromEnv } from '../../../src/modules/notifications/email/nodemailer-mailer';

// Opt-in: runs only against the dev MailHog (docker-compose.dev.yml).
//   docker compose -f docker-compose.dev.yml up -d mailhog
//   MAILHOG_SMOKE_TEST=1 npx vitest run test/integration/email
const enabled = process.env.MAILHOG_SMOKE_TEST === '1';

describe.skipIf(!enabled)('NodemailerMailer against MailHog', () => {
  it('delivers a message that MailHog can read back', async () => {
    const mailer = createMailerFromEnv(
      loadEnv({
        DATABASE_URL: 'postgres://x',
        JWT_ACCESS_SECRET: 'x'.repeat(32),
        SMTP_HOST: 'localhost',
        SMTP_PORT: '1025',
        MAIL_FROM: 'lcms@algihaz.local',
      }),
    );
    const subject = `LCMS smoke ${Date.now()}`;

    await mailer.send({ to: 'smoke@algihaz.local', subject, text: 'Hello from the smoke test' });

    const response = await fetch('http://localhost:8025/api/v2/messages');
    const body = (await response.json()) as { items: Array<{ Content: { Headers: { Subject: string[] } } }> };
    expect(body.items.some((item) => item.Content.Headers.Subject.includes(subject))).toBe(true);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/unit/config/env-smtp.test.ts test/unit/modules/notifications/nodemailer-mailer.test.ts test/unit/helpers/recording-mailer.test.ts test/integration/email`
Expected: FAIL — env keys undefined, `Cannot find module '.../nodemailer-mailer'`, `Cannot find module '.../recording-mailer'` (the smoke test is skipped but fails to import).

- [ ] **Step 4: Implement**

```typescript
// src/config/env.ts — add these keys inside envSchema (after UPLOAD_ALLOWED_EXTENSIONS)
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  MAIL_FROM: z.string().min(1).optional(),
```

```typescript
// src/modules/notifications/email/mailer.ts
export type MailMessage = { to: string; subject: string; text: string };

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}
```

```typescript
// src/modules/notifications/email/nodemailer-mailer.ts
import nodemailer, { type Transporter } from 'nodemailer';
import type { Env } from '../../../config/env';
import type { Mailer, MailMessage } from './mailer';

export class NodemailerMailer implements Mailer {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(transporter: Transporter, from: string) {
    this.transporter = transporter;
    this.from = from;
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}

export function createMailerFromEnv(env: Env): NodemailerMailer {
  if (!env.SMTP_HOST || !env.MAIL_FROM) {
    throw new Error('SMTP_HOST and MAIL_FROM must be set to enable email notifications');
  }
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER && env.SMTP_PASSWORD ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return new NodemailerMailer(transporter, env.MAIL_FROM);
}
```

```typescript
// test/integration/helpers/recording-mailer.ts
import type { Mailer, MailMessage } from '../../../src/modules/notifications/email/mailer';

export class RecordingMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  maxInFlight = 0;
  private inFlight = 0;
  private failuresRemaining = 0;
  private alwaysFail = false;
  private delayMs = 0;

  failNext(count: number): void {
    this.failuresRemaining = count;
  }

  failAlways(): void {
    this.alwaysFail = true;
  }

  setDelay(ms: number): void {
    this.delayMs = ms;
  }

  async send(message: MailMessage): Promise<void> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      if (this.alwaysFail) {
        throw new Error('SMTP unavailable');
      }
      if (this.failuresRemaining > 0) {
        this.failuresRemaining -= 1;
        throw new Error('SMTP unavailable');
      }
      this.sent.push(message);
    } finally {
      this.inFlight -= 1;
    }
  }
}
```

Append to the existing `.env.example`:

```
# Email notifications (SMTP; MailHog in dev — see docker-compose.dev.yml)
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_SECURE=false
MAIL_FROM=lcms@algihaz.local
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run test/unit/config/env-smtp.test.ts test/unit/modules/notifications/nodemailer-mailer.test.ts test/unit/helpers/recording-mailer.test.ts test/integration/email && npx tsc --noEmit`
Expected: PASS (unit tests pass; the MailHog smoke test reports as skipped), `tsc` clean.

- [ ] **Step 6: Commit**

Create `decisions/notifications/task-01-smtp-config-and-mailer.md` (format of `decisions/documents-comments/task-01-config-and-upload-rules.md`: `# Task N — <title>`, `**Date:**`, `**What:**`, `**Why:**`). Add a new `## notifications (Phase 2, sub-project 4)` section to `decisions.md` directly above the `## documents-comments` section with one bullet linking to it. Stage everything and commit once:

```bash
git add package.json pnpm-lock.yaml src/config/env.ts src/modules/notifications/email .env.example test/integration/helpers/recording-mailer.ts test/unit/config/env-smtp.test.ts test/unit/modules/notifications/nodemailer-mailer.test.ts test/unit/helpers/recording-mailer.test.ts test/integration/email decisions.md decisions/notifications/task-01-smtp-config-and-mailer.md
git commit -m "feat: SMTP config, Nodemailer mailer, recording mailer fake"
```

---

### Task 2: Notification entity, migration, reset helper, fixtures

**Files:**
- Create: `src/modules/notifications/entities/notification.entity.ts`
- Create: `src/db/migrations/1700000013000-create-notifications.ts`
- Modify: `src/db/migrations/index.ts`
- Modify: `src/db/entities.ts`
- Modify: `test/integration/helpers/reset-db.ts`
- Create: `test/integration/helpers/seed-notification.ts`
- Test: `test/integration/modules/notifications/notification-entity.test.ts`

**Interfaces:**
- Produces: `AppNotification` entity (`id, userId, type, title, body, relatedCaseId, isRead, readAt, createdAt, emailStatus: EmailStatus, emailAttempts, emailNextAttemptAt, emailSentAt, emailLastError`), `type EmailStatus = 'pending' | 'sent' | 'failed'`; `seedNotification(ds, overrides: { userId: string; type?; title?; body?; relatedCaseId?; isRead?; readAt?; createdAt?; emailStatus?; emailAttempts?; emailNextAttemptAt?; emailSentAt?; emailLastError? }): Promise<AppNotification>`; `listNotificationsFor(ds, userId): Promise<AppNotification[]>` (oldest first).

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/notifications/notification-entity.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedNotification, listNotificationsFor } from '../../helpers/seed-notification';

describe('notifications entity + migration', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  it('round-trips a notification with the in-app and email defaults', async () => {
    const userId = await seedUserWithRole(ds, 'requester');
    const { caseRow } = await seedCaseWithParties(ds);

    const notification = await seedNotification(ds, { userId, relatedCaseId: caseRow.id, title: 'Hello', body: 'World' });

    expect(notification.id).toBeTruthy();
    expect(notification.isRead).toBe(false);
    expect(notification.readAt).toBeNull();
    expect(notification.emailStatus).toBe('pending');
    expect(notification.emailAttempts).toBe(0);
    expect(notification.emailSentAt).toBeNull();
    expect(notification.emailLastError).toBeNull();
    expect(notification.emailNextAttemptAt).toBeInstanceOf(Date);
    expect(notification.createdAt).toBeInstanceOf(Date);
  });

  it('allows a notification with no related case and lists a user\'s rows oldest first', async () => {
    const userId = await seedUserWithRole(ds, 'requester');
    const otherUserId = await seedUserWithRole(ds, 'requester');
    await seedNotification(ds, { userId, title: 'older', createdAt: new Date(Date.now() - 60_000) });
    await seedNotification(ds, { userId, title: 'newer' });
    await seedNotification(ds, { userId: otherUserId, title: 'someone else' });

    const rows = await listNotificationsFor(ds, userId);

    expect(rows.map((row) => row.title)).toEqual(['older', 'newer']);
    expect(rows[0].relatedCaseId).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/modules/notifications/notification-entity.test.ts`
Expected: FAIL — `Cannot find module '../../helpers/seed-notification'`.

- [ ] **Step 3: Write the entity, migration and registrations**

```typescript
// src/modules/notifications/entities/notification.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

export type EmailStatus = 'pending' | 'sent' | 'failed';

@Entity('notifications')
export class AppNotification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar' })
  type!: string;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'uuid', nullable: true })
  relatedCaseId!: string | null;

  @Column({ type: 'boolean', default: false })
  isRead!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  readAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'varchar', default: 'pending' })
  emailStatus!: EmailStatus;

  @Column({ type: 'integer', default: 0 })
  emailAttempts!: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  emailNextAttemptAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  emailSentAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  emailLastError!: string | null;
}
```

```typescript
// src/db/migrations/1700000013000-create-notifications.ts
import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

export class CreateNotifications1700000013000 implements MigrationInterface {
  name = 'CreateNotifications1700000013000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'notifications',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'userId', type: 'uuid' },
          { name: 'type', type: 'varchar' },
          { name: 'title', type: 'varchar' },
          { name: 'body', type: 'text' },
          { name: 'relatedCaseId', type: 'uuid', isNullable: true },
          { name: 'isRead', type: 'boolean', default: false },
          { name: 'readAt', type: 'timestamptz', isNullable: true },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
          { name: 'emailStatus', type: 'varchar', default: `'pending'` },
          { name: 'emailAttempts', type: 'integer', default: 0 },
          { name: 'emailNextAttemptAt', type: 'timestamptz', default: 'now()' },
          { name: 'emailSentAt', type: 'timestamptz', isNullable: true },
          { name: 'emailLastError', type: 'text', isNullable: true },
        ],
      }),
    );
    await queryRunner.createForeignKey('notifications', new TableForeignKey({ columnNames: ['userId'], referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('notifications', new TableForeignKey({ columnNames: ['relatedCaseId'], referencedTableName: 'cases', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createIndex('notifications', new TableIndex({ name: 'IDX_notifications_user_read_created', columnNames: ['userId', 'isRead', 'createdAt'] }));
    await queryRunner.createIndex('notifications', new TableIndex({ name: 'IDX_notifications_pending_email', columnNames: ['emailNextAttemptAt'], where: `"emailStatus" = 'pending'` }));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('notifications');
  }
}
```

```typescript
// src/db/migrations/index.ts — add import and array entry after CreateDocumentsAndComments1700000012000
import { CreateNotifications1700000013000 } from './1700000013000-create-notifications';
// ...
  CreateNotifications1700000013000,
```

```typescript
// src/db/entities.ts — add import and array entry after CaseComment
import { AppNotification } from '../modules/notifications/entities/notification.entity';
// ...
  AppNotification,
```

- [ ] **Step 4: Extend the reset helper (critical)**

`notifications` references `users` and `cases` with RESTRICT. Without this every other test file's reset fails with a foreign-key violation once a notification exists.

```typescript
// test/integration/helpers/reset-db.ts — replace RESET_TABLES_IN_ORDER
const RESET_TABLES_IN_ORDER = [
  'audit_log',
  'notifications',
  'comments',
  'documents',
  'information_requests',
  'refresh_tokens',
  'user_roles',
  'routing_rules',
  'cases',
  'users',
];
```

- [ ] **Step 5: Write the fixtures**

```typescript
// test/integration/helpers/seed-notification.ts
import type { DataSource } from 'typeorm';
import { AppNotification, type EmailStatus } from '../../../src/modules/notifications/entities/notification.entity';

export async function seedNotification(
  ds: DataSource,
  overrides: {
    userId: string;
    type?: string;
    title?: string;
    body?: string;
    relatedCaseId?: string | null;
    isRead?: boolean;
    readAt?: Date | null;
    createdAt?: Date;
    emailStatus?: EmailStatus;
    emailAttempts?: number;
    emailNextAttemptAt?: Date;
    emailSentAt?: Date | null;
    emailLastError?: string | null;
  },
): Promise<AppNotification> {
  const repo = ds.getRepository(AppNotification);
  return repo.save(
    repo.create({
      userId: overrides.userId,
      type: overrides.type ?? 'case.registered',
      title: overrides.title ?? 'A notification',
      body: overrides.body ?? 'Notification body',
      relatedCaseId: overrides.relatedCaseId ?? null,
      isRead: overrides.isRead ?? false,
      readAt: overrides.readAt ?? null,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      ...(overrides.emailStatus ? { emailStatus: overrides.emailStatus } : {}),
      ...(overrides.emailAttempts !== undefined ? { emailAttempts: overrides.emailAttempts } : {}),
      ...(overrides.emailNextAttemptAt ? { emailNextAttemptAt: overrides.emailNextAttemptAt } : {}),
      emailSentAt: overrides.emailSentAt ?? null,
      emailLastError: overrides.emailLastError ?? null,
    }),
  );
}

export async function listNotificationsFor(ds: DataSource, userId: string): Promise<AppNotification[]> {
  return ds.getRepository(AppNotification).find({ where: { userId }, order: { createdAt: 'ASC' } });
}
```

- [ ] **Step 6: Run the test and typecheck**

Run: `npx vitest run test/integration/modules/notifications/notification-entity.test.ts && npx tsc --noEmit`
Expected: PASS (2 tests), `tsc` clean. Then prove the reset change broke nothing: `npx vitest run test/integration/modules/cases test/integration/modules/documents test/integration/modules/comments` — expected PASS.

- [ ] **Step 7: Commit**

Create `decisions/notifications/task-02-entity-migration-fixtures.md` and add one bullet to the top of the `## notifications` section in `decisions.md`.

```bash
git add src/modules/notifications/entities src/db/migrations/1700000013000-create-notifications.ts src/db/migrations/index.ts src/db/entities.ts test/integration/helpers/reset-db.ts test/integration/helpers/seed-notification.ts test/integration/modules/notifications/notification-entity.test.ts decisions.md decisions/notifications/task-02-entity-migration-fixtures.md
git commit -m "feat: notifications table, entity, reset helper and fixtures"
```

---

### Task 3: Event helpers for case lifecycle events

**Files:**
- Create: `src/modules/notifications/notifications.events.ts`
- Test: `test/unit/modules/notifications/to-single-line.test.ts`
- Test: `test/integration/modules/notifications/case-event-helpers.test.ts`

**Interfaces:**
- Consumes: `AppNotification`, `seedCaseWithParties`, `seedNotification`/`listNotificationsFor` (Task 2), `User`/`UserRole`/`Role` entities.
- Produces: `type NotificationSource = DataSource | EntityManager`; `type CaseRef = Pick<Case, 'id' | 'referenceNumber' | 'title' | 'requesterId' | 'assignedLegalRepId'>`; `toSingleLine(text: string): string`; `activeLegalManagerIds(source): Promise<string[]>`; `notifyCaseRegistered(source, caseRow)`, `notifyCaseAssigned(source, caseRow)`, `notifyCaseAccepted(source, caseRow)`, `notifyAssignmentRejected(source, caseRow, reason: string)`, `notifyCaseClosed(source, caseRow)`, `notifySlaBreached(source, caseRow)` — all `Promise<void>`. (Task 4 appends the three information-request helpers to this same file.)

- [ ] **Step 1: Write the failing tests**

```typescript
// test/unit/modules/notifications/to-single-line.test.ts
import { describe, it, expect } from 'vitest';
import { toSingleLine } from '../../../../src/modules/notifications/notifications.events';

describe('toSingleLine', () => {
  it('collapses newlines, tabs and runs of spaces into single spaces and trims', () => {
    expect(toSingleLine('  Case\r\nX-Evil: 1\t\tdone  ')).toBe('Case X-Evil: 1 done');
  });

  it('caps the length at 200 characters', () => {
    expect(toSingleLine('a'.repeat(500))).toHaveLength(200);
  });

  it('keeps non-ASCII text intact', () => {
    expect(toSingleLine('قضية ٢٠٢٦')).toBe('قضية ٢٠٢٦');
  });
});
```

```typescript
// test/integration/modules/notifications/case-event-helpers.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../../helpers/seed-case';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { listNotificationsFor } from '../../helpers/seed-notification';
import {
  activeLegalManagerIds,
  notifyAssignmentRejected,
  notifyCaseAccepted,
  notifyCaseAssigned,
  notifyCaseClosed,
  notifyCaseRegistered,
  notifySlaBreached,
} from '../../../../src/modules/notifications/notifications.events';

describe('case lifecycle notification helpers', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  it('notifyCaseRegistered tells the submitting requester only', async () => {
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds);

    await notifyCaseRegistered(ds, caseRow);

    const rows = await listNotificationsFor(ds, requesterId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'case.registered', relatedCaseId: caseRow.id, isRead: false, emailStatus: 'pending' });
    expect(rows[0].title).toContain(caseRow.referenceNumber);
    expect(rows[0].body).toContain(caseRow.referenceNumber);
    expect(await listNotificationsFor(ds, repId)).toHaveLength(0);
  });

  it('writes the full case title in the body but never the description, and keeps the subject on one line', async () => {
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const hostileTitle = 'Dispute "Acme"\r\nBcc: attacker@evil.test — عقد ' + 'long '.repeat(80);
    const caseRow = await seedCase(ds, { ...master, requesterId, title: hostileTitle, description: 'CONFIDENTIAL DESCRIPTION TEXT 1234567890', status: 'Assigned', assignedLegalRepId: repId });

    await notifyCaseRegistered(ds, caseRow);

    const [row] = await listNotificationsFor(ds, requesterId);
    expect(row.title).not.toMatch(/[\r\n]/);
    expect(row.title.length).toBeLessThanOrEqual(200);
    expect(row.body).toContain(hostileTitle);
    expect(row.body).not.toContain('CONFIDENTIAL DESCRIPTION');
  });

  it('skips an inactive requester', async () => {
    const master = await seedCaseMasterData(ds);
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId, isActive: false });
    const caseRow = await seedCase(ds, { ...master, requesterId });

    await notifyCaseRegistered(ds, caseRow);

    expect(await listNotificationsFor(ds, requesterId)).toHaveLength(0);
  });

  it('notifyCaseAssigned tells the assignee and the requester, with recipient-specific text', async () => {
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Assigned' });

    await notifyCaseAssigned(ds, caseRow);

    const [assignee] = await listNotificationsFor(ds, repId);
    const [requester] = await listNotificationsFor(ds, requesterId);
    expect(assignee.type).toBe('case.assigned');
    expect(assignee.body).toMatch(/assigned to you/i);
    expect(requester.type).toBe('case.assigned');
    expect(requester.body).toMatch(/assigned to a legal representative/i);
    expect(assignee.title).toContain(caseRow.referenceNumber);
  });

  it('notifyCaseAssigned sends one notification when the requester is also the assignee', async () => {
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const caseRow = await seedCase(ds, { ...master, requesterId: repId, status: 'Assigned', assignedLegalRepId: repId });

    await notifyCaseAssigned(ds, caseRow);

    const rows = await listNotificationsFor(ds, repId);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toMatch(/assigned to you/i);
  });

  it('notifyCaseAssigned tolerates a case with no assignee and still tells the requester', async () => {
    const { requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Submitted' });

    await notifyCaseAssigned(ds, caseRow);

    expect(await listNotificationsFor(ds, requesterId)).toHaveLength(1);
  });

  it('notifyCaseAccepted tells the requester only', async () => {
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');

    await notifyCaseAccepted(ds, caseRow);

    const rows = await listNotificationsFor(ds, requesterId);
    expect(rows.map((row) => row.type)).toEqual(['case.accepted']);
    expect(await listNotificationsFor(ds, repId)).toHaveLength(0);
    expect(await listNotificationsFor(ds, managerId)).toHaveLength(0);
  });

  it('notifyAssignmentRejected tells every active legal manager, with the reason, and nobody else', async () => {
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Submitted' });
    const managerA = await seedUserWithRole(ds, 'legal_manager');
    const managerB = await seedUserWithRole(ds, 'legal_manager');
    const inactiveManager = await seedUserWithRole(ds, 'legal_manager', { isActive: false });
    const adminId = await seedUserWithRole(ds, 'admin');

    await notifyAssignmentRejected(ds, caseRow, 'Conflict of interest with the counterparty');

    for (const managerId of [managerA, managerB]) {
      const rows = await listNotificationsFor(ds, managerId);
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('case.rejected');
      expect(rows[0].body).toContain('Conflict of interest with the counterparty');
      expect(rows[0].title).toContain(caseRow.referenceNumber);
    }
    for (const otherId of [inactiveManager, adminId, repId, requesterId]) {
      expect(await listNotificationsFor(ds, otherId)).toHaveLength(0);
    }
  });

  it('notifyAssignmentRejected with no legal manager at all creates nothing and does not throw', async () => {
    const { caseRow } = await seedCaseWithParties(ds, { status: 'Submitted' });

    await expect(notifyAssignmentRejected(ds, caseRow, 'x')).resolves.toBeUndefined();

    const [{ count }] = await ds.query(`SELECT COUNT(*)::int AS count FROM notifications`);
    expect(count).toBe(0);
  });

  it('notifyCaseClosed tells the requester only', async () => {
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Closed' });

    await notifyCaseClosed(ds, caseRow);

    expect((await listNotificationsFor(ds, requesterId)).map((row) => row.type)).toEqual(['case.closed']);
    expect(await listNotificationsFor(ds, repId)).toHaveLength(0);
  });

  it('notifySlaBreached tells every active legal manager', async () => {
    const { caseRow } = await seedCaseWithParties(ds);
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const inactiveManager = await seedUserWithRole(ds, 'legal_manager', { isActive: false });

    await notifySlaBreached(ds, caseRow);

    expect((await listNotificationsFor(ds, managerId)).map((row) => row.type)).toEqual(['sla.breached']);
    expect(await listNotificationsFor(ds, inactiveManager)).toHaveLength(0);
  });

  it('activeLegalManagerIds returns only active users holding the legal_manager role', async () => {
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    await seedUserWithRole(ds, 'legal_manager', { isActive: false });
    await seedUserWithRole(ds, 'admin');
    await seedUserWithRole(ds, 'legal_rep');

    expect(await activeLegalManagerIds(ds)).toEqual([managerId]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/modules/notifications/to-single-line.test.ts test/integration/modules/notifications/case-event-helpers.test.ts`
Expected: FAIL — `Cannot find module '.../notifications.events'`.

- [ ] **Step 3: Implement**

```typescript
// src/modules/notifications/notifications.events.ts
import { In, type DataSource, type EntityManager } from 'typeorm';
import { AppNotification } from './entities/notification.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.entity';
import { Role } from '../users/entities/role.entity';
import type { Case } from '../cases/entities/case.entity';

export type NotificationSource = DataSource | EntityManager;
export type CaseRef = Pick<Case, 'id' | 'referenceNumber' | 'title' | 'requesterId' | 'assignedLegalRepId'>;

type Draft = { userId: string | null | undefined; title: string; body: string };

const MAX_TITLE_LENGTH = 200;

// The title doubles as the email subject, so it must never span lines.
export function toSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
}

export async function activeLegalManagerIds(source: NotificationSource): Promise<string[]> {
  const users = await source
    .getRepository(User)
    .createQueryBuilder('u')
    .innerJoin(UserRole, 'ur', 'ur."userId" = u.id')
    .innerJoin(Role, 'role', 'role.id = ur."roleId"')
    .where('role.name = :roleName', { roleName: 'legal_manager' })
    .andWhere('u."isActive" = true')
    .orderBy('u."createdAt"', 'ASC')
    .getMany();
  return users.map((user) => user.id);
}

async function activeUserIds(source: NotificationSource, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) {
    return new Set();
  }
  const users = await source.getRepository(User).find({ where: { id: In(ids), isActive: true } });
  return new Set(users.map((user) => user.id));
}

// Drafts are taken in order; a user already seen is skipped (first match wins),
// a missing or inactive recipient is skipped silently.
async function createNotifications(
  source: NotificationSource,
  type: string,
  relatedCaseId: string,
  drafts: Draft[],
): Promise<void> {
  const seen = new Set<string>();
  const unique: Array<Draft & { userId: string }> = [];
  for (const draft of drafts) {
    if (!draft.userId || seen.has(draft.userId)) {
      continue;
    }
    seen.add(draft.userId);
    unique.push({ ...draft, userId: draft.userId });
  }
  const active = await activeUserIds(source, unique.map((draft) => draft.userId));
  const repo = source.getRepository(AppNotification);
  const rows = unique
    .filter((draft) => active.has(draft.userId))
    .map((draft) =>
      repo.create({
        userId: draft.userId,
        type,
        title: toSingleLine(draft.title),
        body: draft.body,
        relatedCaseId,
        isRead: false,
        readAt: null,
      }),
    );
  if (rows.length > 0) {
    await repo.save(rows);
  }
}

export async function createManagerNotifications(
  source: NotificationSource,
  type: string,
  caseRow: CaseRef,
  title: string,
  body: string,
): Promise<void> {
  const managerIds = await activeLegalManagerIds(source);
  await createNotifications(source, type, caseRow.id, managerIds.map((userId) => ({ userId, title, body })));
}

export async function notifyCaseRegistered(source: NotificationSource, caseRow: CaseRef): Promise<void> {
  await createNotifications(source, 'case.registered', caseRow.id, [
    {
      userId: caseRow.requesterId,
      title: `Case ${caseRow.referenceNumber} registered`,
      body: `Your case "${caseRow.title}" (${caseRow.referenceNumber}) has been registered.`,
    },
  ]);
}

export async function notifyCaseAssigned(source: NotificationSource, caseRow: CaseRef): Promise<void> {
  await createNotifications(source, 'case.assigned', caseRow.id, [
    {
      userId: caseRow.assignedLegalRepId,
      title: `Case ${caseRow.referenceNumber} assigned to you`,
      body: `Case "${caseRow.title}" (${caseRow.referenceNumber}) has been assigned to you. Please accept or reject it.`,
    },
    {
      userId: caseRow.requesterId,
      title: `Case ${caseRow.referenceNumber} assigned`,
      body: `Your case "${caseRow.title}" (${caseRow.referenceNumber}) has been assigned to a legal representative.`,
    },
  ]);
}

export async function notifyCaseAccepted(source: NotificationSource, caseRow: CaseRef): Promise<void> {
  await createNotifications(source, 'case.accepted', caseRow.id, [
    {
      userId: caseRow.requesterId,
      title: `Case ${caseRow.referenceNumber} accepted`,
      body: `Your case "${caseRow.title}" (${caseRow.referenceNumber}) has been accepted and is now in progress.`,
    },
  ]);
}

export async function notifyAssignmentRejected(source: NotificationSource, caseRow: CaseRef, reason: string): Promise<void> {
  await createManagerNotifications(
    source,
    'case.rejected',
    caseRow,
    `Assignment rejected for case ${caseRow.referenceNumber}`,
    `The assignment of case "${caseRow.title}" (${caseRow.referenceNumber}) was rejected and the case needs reassignment. Reason: ${reason}`,
  );
}

export async function notifyCaseClosed(source: NotificationSource, caseRow: CaseRef): Promise<void> {
  await createNotifications(source, 'case.closed', caseRow.id, [
    {
      userId: caseRow.requesterId,
      title: `Case ${caseRow.referenceNumber} closed`,
      body: `Your case "${caseRow.title}" (${caseRow.referenceNumber}) has been resolved and closed.`,
    },
  ]);
}

export async function notifySlaBreached(source: NotificationSource, caseRow: CaseRef): Promise<void> {
  await createManagerNotifications(
    source,
    'sla.breached',
    caseRow,
    `SLA breached for case ${caseRow.referenceNumber}`,
    `Case "${caseRow.title}" (${caseRow.referenceNumber}) has passed its resolution due date.`,
  );
}
```

Also export `createNotifications` (add `export` to its declaration): Task 4's helpers reuse it from the same file, and keeping it in one file avoids a second module for a 30-line function.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/unit/modules/notifications/to-single-line.test.ts test/integration/modules/notifications/case-event-helpers.test.ts && npx tsc --noEmit`
Expected: PASS (3 unit + 12 integration tests), `tsc` clean.

- [ ] **Step 5: Commit**

Create `decisions/notifications/task-03-case-event-helpers.md` and add one bullet to the top of the `## notifications` section in `decisions.md`.

```bash
git add src/modules/notifications/notifications.events.ts test/unit/modules/notifications/to-single-line.test.ts test/integration/modules/notifications/case-event-helpers.test.ts decisions.md decisions/notifications/task-03-case-event-helpers.md
git commit -m "feat: notification event helpers for case lifecycle events"
```

---

### Task 4: Event helpers for information requests

**Files:**
- Modify: `src/modules/notifications/notifications.events.ts`
- Test: `test/integration/modules/notifications/information-request-event-helpers.test.ts`

**Interfaces:**
- Consumes: `createNotifications` (exported from the same file), `CaseRef`, `NotificationSource`, `seedInformationRequest`, `seedCaseWithParties`.
- Produces: `type InformationRequestRef = Pick<InformationRequest, 'id' | 'responderId'>`; `notifyInformationRequestRaised(source, caseRow: CaseRef, request: InformationRequestRef)`, `notifyInformationRequestAnswered(source, caseRow, request)`, `notifyInformationRequestReopened(source, caseRow, request)` — all `Promise<void>`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/notifications/information-request-event-helpers.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../../helpers/seed-case';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedInformationRequest } from '../../helpers/seed-information-request';
import { listNotificationsFor } from '../../helpers/seed-notification';
import {
  notifyInformationRequestAnswered,
  notifyInformationRequestRaised,
  notifyInformationRequestReopened,
} from '../../../../src/modules/notifications/notifications.events';

describe('information-request notification helpers', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  it('notifyInformationRequestRaised tells the responder and the requester, not the raising rep', async () => {
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const responderId = await seedUserWithRole(ds, 'requester');
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, subject: 'SECRET SUBJECT LINE' });

    await notifyInformationRequestRaised(ds, caseRow, request);

    const [forResponder] = await listNotificationsFor(ds, responderId);
    const [forRequester] = await listNotificationsFor(ds, requesterId);
    expect(forResponder).toMatchObject({ type: 'info_request.raised', relatedCaseId: caseRow.id });
    expect(forResponder.body).toMatch(/asked to provide information/i);
    expect(forRequester.type).toBe('info_request.raised');
    expect(forRequester.body).toMatch(/information request has been raised/i);
    expect(forResponder.title).toContain(caseRow.referenceNumber);
    expect(forResponder.body).not.toContain('SECRET SUBJECT LINE');
    expect(await listNotificationsFor(ds, repId)).toHaveLength(0);
  });

  it('notifyInformationRequestRaised sends one notification when the requester is also the responder', async () => {
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId: requesterId });

    await notifyInformationRequestRaised(ds, caseRow, request);

    const rows = await listNotificationsFor(ds, requesterId);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toMatch(/asked to provide information/i);
  });

  it('notifyInformationRequestRaised skips an inactive responder but still tells the requester', async () => {
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const responderId = await seedUserWithRole(ds, 'requester', { isActive: false });
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });

    await notifyInformationRequestRaised(ds, caseRow, request);

    expect(await listNotificationsFor(ds, responderId)).toHaveLength(0);
    expect(await listNotificationsFor(ds, requesterId)).toHaveLength(1);
  });

  it('notifyInformationRequestAnswered tells the assigned rep only', async () => {
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds);
    const responderId = await seedUserWithRole(ds, 'requester');
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'answered', responseText: 'SECRET ANSWER TEXT' });

    await notifyInformationRequestAnswered(ds, caseRow, request);

    const rows = await listNotificationsFor(ds, repId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'info_request.answered', relatedCaseId: caseRow.id });
    expect(rows[0].body).not.toContain('SECRET ANSWER TEXT');
    expect(await listNotificationsFor(ds, responderId)).toHaveLength(0);
    expect(await listNotificationsFor(ds, requesterId)).toHaveLength(0);
  });

  it('notifyInformationRequestAnswered creates nothing and does not throw when the case has no assigned rep', async () => {
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: null });
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId: requesterId, status: 'answered', responseText: 'x' });

    await expect(notifyInformationRequestAnswered(ds, caseRow, request)).resolves.toBeUndefined();

    const [{ count }] = await ds.query(`SELECT COUNT(*)::int AS count FROM notifications`);
    expect(count).toBe(0);
  });

  it('notifyInformationRequestReopened tells the responder only, without the reopen comment', async () => {
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const responderId = await seedUserWithRole(ds, 'requester');
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, requirementDescription: 'SECRET REOPEN COMMENT' });

    await notifyInformationRequestReopened(ds, caseRow, request);

    const rows = await listNotificationsFor(ds, responderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'info_request.reopened', relatedCaseId: caseRow.id });
    expect(rows[0].body).not.toContain('SECRET REOPEN COMMENT');
    expect(await listNotificationsFor(ds, requesterId)).toHaveLength(0);
    expect(await listNotificationsFor(ds, repId)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/modules/notifications/information-request-event-helpers.test.ts`
Expected: FAIL — `notifyInformationRequestRaised is not a function` (the exports do not exist yet).

- [ ] **Step 3: Implement (append to `notifications.events.ts`)**

```typescript
// src/modules/notifications/notifications.events.ts — add to the imports
import type { InformationRequest } from '../information-requests/entities/information-request.entity';

// append at the end of the file
export type InformationRequestRef = Pick<InformationRequest, 'id' | 'responderId'>;

export async function notifyInformationRequestRaised(
  source: NotificationSource,
  caseRow: CaseRef,
  request: InformationRequestRef,
): Promise<void> {
  await createNotifications(source, 'info_request.raised', caseRow.id, [
    {
      userId: request.responderId,
      title: `Information requested on case ${caseRow.referenceNumber}`,
      body: `You have been asked to provide information on case "${caseRow.title}" (${caseRow.referenceNumber}).`,
    },
    {
      userId: caseRow.requesterId,
      title: `Information requested on case ${caseRow.referenceNumber}`,
      body: `An information request has been raised on your case "${caseRow.title}" (${caseRow.referenceNumber}).`,
    },
  ]);
}

export async function notifyInformationRequestAnswered(
  source: NotificationSource,
  caseRow: CaseRef,
  _request: InformationRequestRef,
): Promise<void> {
  await createNotifications(source, 'info_request.answered', caseRow.id, [
    {
      userId: caseRow.assignedLegalRepId,
      title: `Information received on case ${caseRow.referenceNumber}`,
      body: `An information request on case "${caseRow.title}" (${caseRow.referenceNumber}) has been answered.`,
    },
  ]);
}

export async function notifyInformationRequestReopened(
  source: NotificationSource,
  caseRow: CaseRef,
  request: InformationRequestRef,
): Promise<void> {
  await createNotifications(source, 'info_request.reopened', caseRow.id, [
    {
      userId: request.responderId,
      title: `Information request reopened on case ${caseRow.referenceNumber}`,
      body: `An information request on case "${caseRow.title}" (${caseRow.referenceNumber}) has been reopened and needs a new response.`,
    },
  ]);
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules/notifications && npx tsc --noEmit`
Expected: PASS (Task 2-3 tests plus 6 new), `tsc` clean.

- [ ] **Step 5: Commit**

Create `decisions/notifications/task-04-information-request-event-helpers.md` and add one bullet to the top of the `## notifications` section in `decisions.md`.

```bash
git add src/modules/notifications/notifications.events.ts test/integration/modules/notifications/information-request-event-helpers.test.ts decisions.md decisions/notifications/task-04-information-request-event-helpers.md
git commit -m "feat: notification event helpers for information requests"
```

---

### Task 5: Wire the case actions to notifications

**Files:**
- Modify: `src/modules/cases/cases.service.ts` (`submitCase`)
- Modify: `src/modules/cases/cases.workflow.service.ts` (`assignCase`, `acceptAssignment`, `rejectAssignment`, `closeCase`)
- Test: `test/integration/modules/notifications/case-events.test.ts`

**Interfaces:**
- Consumes: `notifyCaseRegistered`, `notifyCaseAssigned`, `notifyCaseAccepted`, `notifyAssignmentRejected`, `notifyCaseClosed` (Task 3).
- Produces: no new exports; the five existing actions now also create notification rows.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/notifications/case-events.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../../helpers/seed-case';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedInformationRequest } from '../../helpers/seed-information-request';
import { listNotificationsFor } from '../../helpers/seed-notification';
import { authHeader } from '../../helpers/auth-header';

describe('notifications created by case actions', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  const types = async (userId: string) => (await listNotificationsFor(ds, userId)).map((row) => row.type);

  // The pre-seeded 'Internal' category is the only one a requester may submit.
  async function internalCategoryAndType() {
    const [category] = await ds.query(`SELECT id FROM case_categories WHERE name = 'Internal'`);
    const [caseType] = await ds.query(
      `INSERT INTO case_types (id, "categoryId", name, "slaAckHours", "slaResolutionHours") VALUES (gen_random_uuid(), $1, $2, 24, 72) RETURNING id`,
      [category.id, `Internal-Type-${Date.now()}-${Math.random()}`],
    );
    return { categoryId: category.id as string, caseTypeId: caseType.id as string };
  }

  function submitPayload(master: { departmentId: string }, ids: { categoryId: string; caseTypeId: string }, title = 'Need contract review') {
    return {
      title,
      description: 'This case description is definitely at least twenty characters.',
      declarationConfirmed: true,
      categoryId: ids.categoryId,
      caseTypeId: ids.caseTypeId,
      departmentId: master.departmentId,
    };
  }

  it('submitting a case with no routing rule registers it: only the requester is notified', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const ids = await internalCategoryAndType();
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId, businessUnitId: master.businessUnitId });
    const managerId = await seedUserWithRole(ds, 'legal_manager');

    const res = await app.inject({ method: 'POST', url: '/cases', headers: authHeader(app, requesterId, 'requester'), payload: submitPayload(master, ids) });

    expect(res.statusCode).toBe(201);
    expect(await types(requesterId)).toEqual(['case.registered']);
    expect(await types(managerId)).toEqual([]);
    const [row] = await listNotificationsFor(ds, requesterId);
    expect(row.relatedCaseId).toBe(res.json().id);
    expect(row.body).toContain(res.json().referenceNumber);
    await app.close();
  });

  it('auto-assignment on submit notifies the requester twice (registered, assigned) and the assignee once', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const ids = await internalCategoryAndType();
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId, businessUnitId: master.businessUnitId });
    const assigneeId = await seedUserWithRole(ds, 'legal_rep', { entityId: master.entityId });
    await ds.query(
      `INSERT INTO routing_rules (id, "matchCriteria", "targetLegalRepId", "priorityOrder", "isActive") VALUES (gen_random_uuid(), $1, $2, 1, true)`,
      [JSON.stringify({ categoryId: ids.categoryId }), assigneeId],
    );

    const res = await app.inject({ method: 'POST', url: '/cases', headers: authHeader(app, requesterId, 'requester'), payload: submitPayload(master, ids) });

    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('Assigned');
    expect(await types(requesterId)).toEqual(['case.registered', 'case.assigned']);
    expect(await types(assigneeId)).toEqual(['case.assigned']);
    await app.close();
  });

  it('a lawyer who submits a case that auto-routes to themselves gets one assignment notification, not two', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep', { entityId: master.entityId });
    await ds.query(
      `INSERT INTO routing_rules (id, "matchCriteria", "targetLegalRepId", "priorityOrder", "isActive") VALUES (gen_random_uuid(), $1, $2, 1, true)`,
      [JSON.stringify({ categoryId: master.categoryId }), repId],
    );

    const res = await app.inject({
      method: 'POST',
      url: '/cases',
      headers: authHeader(app, repId, 'legal_rep'),
      payload: { ...submitPayload(master, { categoryId: master.categoryId, caseTypeId: master.caseTypeId }), entityId: master.entityId },
    });

    expect(res.statusCode).toBe(201);
    expect(await types(repId)).toEqual(['case.registered', 'case.assigned']);
    await app.close();
  });

  it('a manager assigning a case notifies the assignee and the requester, not the manager', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Submitted' });
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const managerId = await seedUserWithRole(ds, 'legal_manager');

    const res = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}/assign`, headers: authHeader(app, managerId, 'legal_manager'), payload: { targetLegalRepId: repId } });

    expect(res.statusCode).toBe(200);
    expect(await types(repId)).toEqual(['case.assigned']);
    expect(await types(requesterId)).toEqual(['case.assigned']);
    expect(await types(managerId)).toEqual([]);
    await app.close();
  });

  it('assign, reject, reassign: managers hear about the rejection and the second assignee gets exactly one assignment', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Submitted' });
    const firstRepId = await seedUserWithRole(ds, 'legal_rep');
    const secondRepId = await seedUserWithRole(ds, 'legal_rep');
    const managerId = await seedUserWithRole(ds, 'legal_manager');
    const otherManagerId = await seedUserWithRole(ds, 'legal_manager');

    await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}/assign`, headers: authHeader(app, managerId, 'legal_manager'), payload: { targetLegalRepId: firstRepId } });
    const reject = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}/reject`, headers: authHeader(app, firstRepId, 'legal_rep'), payload: { reason: 'Conflict of interest' } });
    await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}/assign`, headers: authHeader(app, managerId, 'legal_manager'), payload: { targetLegalRepId: secondRepId } });

    expect(reject.statusCode).toBe(200);
    expect(await types(firstRepId)).toEqual(['case.assigned']);
    expect(await types(secondRepId)).toEqual(['case.assigned']);
    for (const id of [managerId, otherManagerId]) {
      const rows = await listNotificationsFor(ds, id);
      expect(rows.map((row) => row.type)).toEqual(['case.rejected']);
      expect(rows[0].body).toContain('Conflict of interest');
    }
    expect((await types(requesterId)).filter((type) => type === 'case.assigned')).toHaveLength(2);
    await app.close();
  });

  it('rejecting when there is no active legal manager still succeeds and creates no manager notification', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, caseRow } = await seedCaseWithParties(ds, { status: 'Assigned' });

    const res = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}/reject`, headers: authHeader(app, repId, 'legal_rep'), payload: { reason: 'Not my area' } });

    expect(res.statusCode).toBe(200);
    expect(await types(repId)).toEqual([]);
    await app.close();
  });

  it('accepting a case notifies the requester only', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Assigned' });
    const managerId = await seedUserWithRole(ds, 'legal_manager');

    const res = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}/accept`, headers: authHeader(app, repId, 'legal_rep') });

    expect(res.statusCode).toBe(200);
    expect(await types(requesterId)).toEqual(['case.accepted']);
    expect(await types(repId)).toEqual([]);
    expect(await types(managerId)).toEqual([]);
    await app.close();
  });

  it('closing a case notifies the requester only', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds);
    const [outcome] = await ds.query(`INSERT INTO closure_outcomes (id, name) VALUES (gen_random_uuid(), $1) RETURNING id`, [`Resolved-${Date.now()}-${Math.random()}`]);

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}/close`,
      headers: authHeader(app, repId, 'legal_rep'),
      payload: { confirm: true, closureSummary: 'Settled.', closureOutcomeId: outcome.id },
    });

    expect(res.statusCode).toBe(200);
    expect(await types(requesterId)).toEqual(['case.closed']);
    expect(await types(repId)).toEqual([]);
    await app.close();
  });

  it('a close blocked by an open information request leaves no notification behind', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds);
    const responderId = await seedUserWithRole(ds, 'requester');
    await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });
    const [outcome] = await ds.query(`INSERT INTO closure_outcomes (id, name) VALUES (gen_random_uuid(), $1) RETURNING id`, [`Resolved-${Date.now()}-${Math.random()}`]);

    const res = await app.inject({
      method: 'PATCH',
      url: `/cases/${caseRow.id}/close`,
      headers: authHeader(app, repId, 'legal_rep'),
      payload: { confirm: true, closureSummary: 'x', closureOutcomeId: outcome.id },
    });

    expect(res.statusCode).toBe(409);
    expect(await types(requesterId)).toEqual([]);
    await app.close();
  });

  it('an inactive requester receives nothing when their case is accepted', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const repId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId, isActive: false });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Assigned', assignedLegalRepId: repId });

    const res = await app.inject({ method: 'PATCH', url: `/cases/${caseRow.id}/accept`, headers: authHeader(app, repId, 'legal_rep') });

    expect(res.statusCode).toBe(200);
    expect(await types(requesterId)).toEqual([]);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/modules/notifications/case-events.test.ts`
Expected: FAIL — the actions succeed but no notification rows exist (assertions on `types(...)` fail).

- [ ] **Step 3: Add the calls**

```typescript
// src/modules/cases/cases.service.ts — add the import
import { notifyCaseRegistered } from '../notifications/notifications.events';

// in submitCase, directly after the `case.submitted` logAuditEvent call and before `const match = await evaluateAutoRouting(...)`:
  await notifyCaseRegistered(dataSource, caseRow);
```

```typescript
// src/modules/cases/cases.workflow.service.ts — add the import
import {
  notifyAssignmentRejected,
  notifyCaseAccepted,
  notifyCaseAssigned,
  notifyCaseClosed,
} from '../notifications/notifications.events';

// assignCase: immediately after its logAuditEvent call, before `return caseRow;`
  await notifyCaseAssigned(dataSource, caseRow);

// acceptAssignment: immediately after its logAuditEvent call, before `return caseRow;`
  await notifyCaseAccepted(dataSource, caseRow);

// rejectAssignment: immediately after its logAuditEvent call, before `return caseRow;`
  await notifyAssignmentRejected(dataSource, caseRow, reason);

// closeCase: inside the transaction callback, immediately after its logAuditEvent call, before `return caseRow;`
    await notifyCaseClosed(manager, caseRow);
```

Each `return caseRow;` above is the one that ends that specific function; do not touch `setEscalation`, `markCaseWaitingOnInput` or `markCaseInProgress`. Do not change any signature, status code, authorization rule or audit call.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules/notifications/case-events.test.ts && npx tsc --noEmit`
Expected: PASS (10 tests), `tsc` clean. Then prove nothing regressed: `npx vitest run test/integration/modules/cases test/integration/modules/information-requests test/integration/modules/documents test/integration/modules/comments` — expected PASS.

- [ ] **Step 5: Commit**

Create `decisions/notifications/task-05-case-action-wiring.md` and add one bullet to the top of the `## notifications` section in `decisions.md`.

```bash
git add src/modules/cases/cases.service.ts src/modules/cases/cases.workflow.service.ts test/integration/modules/notifications/case-events.test.ts decisions.md decisions/notifications/task-05-case-action-wiring.md
git commit -m "feat: create notifications on case submit, assign, accept, reject and close"
```

---

### Task 6: Wire the information-request actions to notifications

**Files:**
- Modify: `src/modules/information-requests/information-requests.service.ts`
- Test: `test/integration/modules/notifications/information-request-events.test.ts`

**Interfaces:**
- Consumes: `notifyInformationRequestRaised`, `notifyInformationRequestAnswered`, `notifyInformationRequestReopened` (Task 4).
- Produces: no new exports; raise, respond and reopen now also create notification rows inside their existing transaction.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/notifications/information-request-events.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCase, seedCaseMasterData } from '../../helpers/seed-case';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedInformationRequest } from '../../helpers/seed-information-request';
import { listNotificationsFor } from '../../helpers/seed-notification';
import { authHeader } from '../../helpers/auth-header';

describe('notifications created by information-request actions', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  const types = async (userId: string) => (await listNotificationsFor(ds, userId)).map((row) => row.type);

  it('raising a request notifies the responder and the requester, not the raising rep', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds);
    const responderId = await seedUserWithRole(ds, 'requester');

    const res = await app.inject({
      method: 'POST',
      url: `/cases/${caseRow.id}/information-requests`,
      headers: authHeader(app, repId, 'legal_rep'),
      payload: { subject: 'Need clarification', requirementDescription: 'Please confirm the affected unit.', responderId },
    });

    expect(res.statusCode).toBe(201);
    expect(await types(responderId)).toEqual(['info_request.raised']);
    expect(await types(requesterId)).toEqual(['info_request.raised']);
    expect(await types(repId)).toEqual([]);
    const [row] = await listNotificationsFor(ds, responderId);
    expect(row.relatedCaseId).toBe(caseRow.id);
    expect(row.body).not.toContain('Please confirm the affected unit.');
    await app.close();
  });

  it('raising a request whose responder is the requester sends one notification', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds);

    const res = await app.inject({
      method: 'POST',
      url: `/cases/${caseRow.id}/information-requests`,
      headers: authHeader(app, repId, 'legal_rep'),
      payload: { subject: 's', requirementDescription: 'd', responderId: requesterId },
    });

    expect(res.statusCode).toBe(201);
    expect(await types(requesterId)).toEqual(['info_request.raised']);
    await app.close();
  });

  it('answering a request notifies the assigned rep only', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds, { status: 'Waiting on Input' });
    const responderId = await seedUserWithRole(ds, 'requester');
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${request.id}/respond`,
      headers: authHeader(app, responderId, 'requester'),
      payload: { responseText: 'The affected unit is Operations.' },
    });

    expect(res.statusCode).toBe(200);
    expect(await types(repId)).toEqual(['info_request.answered']);
    expect(await types(responderId)).toEqual([]);
    expect(await types(requesterId)).toEqual([]);
    const [row] = await listNotificationsFor(ds, repId);
    expect(row.body).not.toContain('Operations');
    await app.close();
  });

  it('answering on a case that has no assigned rep still succeeds and notifies nobody', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const master = await seedCaseMasterData(ds);
    const raiserId = await seedUserWithRole(ds, 'legal_rep');
    const requesterId = await seedUserWithRole(ds, 'requester', { departmentId: master.departmentId, entityId: master.entityId });
    const caseRow = await seedCase(ds, { ...master, requesterId, status: 'Waiting on Input', assignedLegalRepId: null });
    const request = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: raiserId, responderId: requesterId });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${request.id}/respond`,
      headers: authHeader(app, requesterId, 'requester'),
      payload: { responseText: 'done' },
    });

    expect(res.statusCode).toBe(200);
    const [{ count }] = await ds.query(`SELECT COUNT(*)::int AS count FROM notifications`);
    expect(count).toBe(0);
    await app.close();
  });

  it('reopening a request notifies the responder only, not the raising rep or the requester', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { repId, requesterId, caseRow } = await seedCaseWithParties(ds);
    const responderId = await seedUserWithRole(ds, 'requester');
    const answered = await seedInformationRequest(ds, { caseId: caseRow.id, raisedById: repId, responderId, status: 'answered', responseText: 'thin answer' });

    const res = await app.inject({
      method: 'POST',
      url: `/information-requests/${answered.id}/reopen`,
      headers: authHeader(app, repId, 'legal_rep'),
      payload: { comment: 'This does not name the business unit.' },
    });

    expect(res.statusCode).toBe(200);
    expect(await types(responderId)).toEqual(['info_request.reopened']);
    expect(await types(repId)).toEqual([]);
    expect(await types(requesterId)).toEqual([]);
    const [row] = await listNotificationsFor(ds, responderId);
    expect(row.body).not.toContain('business unit');
    await app.close();
  });

  it('a rejected raise (wrong rep) creates no notifications', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const { requesterId, caseRow } = await seedCaseWithParties(ds);
    const otherRepId = await seedUserWithRole(ds, 'legal_rep');
    const responderId = await seedUserWithRole(ds, 'requester');

    const res = await app.inject({
      method: 'POST',
      url: `/cases/${caseRow.id}/information-requests`,
      headers: authHeader(app, otherRepId, 'legal_rep'),
      payload: { subject: 's', requirementDescription: 'd', responderId },
    });

    expect(res.statusCode).toBe(403);
    expect(await types(responderId)).toEqual([]);
    expect(await types(requesterId)).toEqual([]);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/modules/notifications/information-request-events.test.ts`
Expected: FAIL — the actions succeed but no notification rows exist.

- [ ] **Step 3: Add the calls**

```typescript
// src/modules/information-requests/information-requests.service.ts — add the import
import {
  notifyInformationRequestAnswered,
  notifyInformationRequestRaised,
  notifyInformationRequestReopened,
} from '../notifications/notifications.events';

// raiseInformationRequest: inside the transaction callback, immediately after its logAuditEvent call, before `return infoRequest;`
    await notifyInformationRequestRaised(manager, caseRow, infoRequest);

// respondToInformationRequest: inside the transaction callback, immediately after its logAuditEvent call, before `return infoRequest;`
    await notifyInformationRequestAnswered(manager, caseRow, infoRequest);

// reopenInformationRequest: inside the transaction callback, immediately after its logAuditEvent call, before `return reopened;`
    await notifyInformationRequestReopened(manager, caseRow, reopened);
```

`caseRow` in each of these three functions is the case row already loaded under the case lock by `lockCaseOrThrow`. Do not touch `listInformationRequestsForCase`, and do not change any signature, status code, authorization rule or audit call.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules/notifications test/integration/modules/information-requests && npx tsc --noEmit`
Expected: PASS, `tsc` clean.

- [ ] **Step 5: Commit**

Create `decisions/notifications/task-06-information-request-wiring.md` and add one bullet to the top of the `## notifications` section in `decisions.md`.

```bash
git add src/modules/information-requests/information-requests.service.ts test/integration/modules/notifications/information-request-events.test.ts decisions.md decisions/notifications/task-06-information-request-wiring.md
git commit -m "feat: create notifications on information request raise, answer and reopen"
```

---

### Task 7: In-app notification API

**Files:**
- Create: `src/modules/notifications/notifications.schemas.ts`
- Create: `src/modules/notifications/notifications.service.ts`
- Create: `src/modules/notifications/notifications.routes.ts`
- Modify: `src/app.ts`
- Test: `test/integration/modules/notifications/notifications-api.test.ts`

**Interfaces:**
- Consumes: `AppNotification`, `seedNotification`, `paginationQuerySchema`/`paginationToSkipTake`/`buildPaginatedResponse` from `src/shared/pagination.ts`, `NotFoundError`.
- Produces: `listNotifications(dataSource, userId, query: { page: number; pageSize: number; isRead?: boolean })` returning `{ items: AppNotification[]; total; page; pageSize; unreadCount }`; `markNotificationRead(dataSource, userId, notificationId): Promise<AppNotification>`; `serializeNotification(row)`; routes `GET /notifications`, `PATCH /notifications/:id/read`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/notifications/notifications-api.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { buildTestApp } from '../../helpers/build-test-app';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedCaseWithParties } from '../../helpers/seed-case-scenario';
import { seedNotification } from '../../helpers/seed-notification';
import { authHeader } from '../../helpers/auth-header';

describe('GET /notifications and PATCH /notifications/:id/read', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  const ago = (ms: number) => new Date(Date.now() - ms);

  it('lists only the caller\'s notifications, newest first, with the unread count', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'requester');
    const otherId = await seedUserWithRole(ds, 'requester');
    const { caseRow } = await seedCaseWithParties(ds);
    await seedNotification(ds, { userId, title: 'oldest', createdAt: ago(3000), isRead: true, readAt: ago(1000) });
    await seedNotification(ds, { userId, title: 'middle', createdAt: ago(2000), relatedCaseId: caseRow.id });
    await seedNotification(ds, { userId, title: 'newest', createdAt: ago(1000) });
    await seedNotification(ds, { userId: otherId, title: 'not mine' });

    const res = await app.inject({ method: 'GET', url: '/notifications', headers: authHeader(app, userId, 'requester') });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((item: { title: string }) => item.title)).toEqual(['newest', 'middle', 'oldest']);
    expect(body).toMatchObject({ total: 3, page: 1, pageSize: 20, unreadCount: 2 });
    const middle = body.items[1];
    expect(middle).toMatchObject({ type: 'case.registered', relatedCaseId: caseRow.id, isRead: false, readAt: null });
    expect(typeof middle.createdAt).toBe('string');
    expect(middle).not.toHaveProperty('emailStatus');
    expect(middle).not.toHaveProperty('userId');
    await app.close();
  });

  it('filters by isRead while unreadCount still reflects every unread notification', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'legal_rep');
    await seedNotification(ds, { userId, title: 'read one', isRead: true, readAt: new Date() });
    await seedNotification(ds, { userId, title: 'unread one' });
    await seedNotification(ds, { userId, title: 'unread two' });

    const unread = await app.inject({ method: 'GET', url: '/notifications?isRead=false', headers: authHeader(app, userId, 'legal_rep') });
    const read = await app.inject({ method: 'GET', url: '/notifications?isRead=true', headers: authHeader(app, userId, 'legal_rep') });

    expect(unread.json().total).toBe(2);
    expect(unread.json().unreadCount).toBe(2);
    expect(read.json().items.map((item: { title: string }) => item.title)).toEqual(['read one']);
    expect(read.json().total).toBe(1);
    expect(read.json().unreadCount).toBe(2);
    await app.close();
  });

  it('paginates', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'admin');
    for (let i = 0; i < 5; i += 1) {
      await seedNotification(ds, { userId, title: `n${i}`, createdAt: ago((5 - i) * 1000) });
    }

    const page2 = await app.inject({ method: 'GET', url: '/notifications?page=2&pageSize=2', headers: authHeader(app, userId, 'admin') });

    expect(page2.json().items.map((item: { title: string }) => item.title)).toEqual(['n2', 'n1']);
    expect(page2.json()).toMatchObject({ total: 5, page: 2, pageSize: 2, unreadCount: 5 });
    await app.close();
  });

  it('rejects an invalid isRead value or page size with 400', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'requester');

    const badFlag = await app.inject({ method: 'GET', url: '/notifications?isRead=maybe', headers: authHeader(app, userId, 'requester') });
    const badSize = await app.inject({ method: 'GET', url: '/notifications?pageSize=1000', headers: authHeader(app, userId, 'requester') });

    expect(badFlag.statusCode).toBe(400);
    expect(badSize.statusCode).toBe(400);
    await app.close();
  });

  it('requires authentication', async () => {
    const app = buildTestApp(ds);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/notifications' });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('marks a notification read once: readAt is set and a second call leaves it unchanged', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'requester');
    const notification = await seedNotification(ds, { userId });

    const first = await app.inject({ method: 'PATCH', url: `/notifications/${notification.id}/read`, headers: authHeader(app, userId, 'requester') });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await app.inject({ method: 'PATCH', url: `/notifications/${notification.id}/read`, headers: authHeader(app, userId, 'requester') });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id: notification.id, isRead: true });
    expect(first.json().readAt).not.toBeNull();
    expect(second.statusCode).toBe(200);
    expect(second.json().readAt).toBe(first.json().readAt);
    await app.close();
  });

  it('returns 404 for another user\'s notification and for an unknown id', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const userId = await seedUserWithRole(ds, 'requester');
    const otherId = await seedUserWithRole(ds, 'requester');
    const notification = await seedNotification(ds, { userId });

    const foreign = await app.inject({ method: 'PATCH', url: `/notifications/${notification.id}/read`, headers: authHeader(app, otherId, 'requester') });
    const unknown = await app.inject({ method: 'PATCH', url: '/notifications/6f1d2c4a-8b3e-4a7d-9c5f-0e1a2b3c4d5e/read', headers: authHeader(app, userId, 'requester') });

    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    const [row] = await ds.query(`SELECT "isRead" FROM notifications WHERE id = $1`, [notification.id]);
    expect(row.isRead).toBe(false);
    await app.close();
  });

  it('lets a viewer list and mark their own notifications read', async () => {
    const app = buildTestApp(ds);
    await app.ready();
    const viewerId = await seedUserWithRole(ds, 'viewer');
    const notification = await seedNotification(ds, { userId: viewerId });

    const list = await app.inject({ method: 'GET', url: '/notifications', headers: authHeader(app, viewerId, 'viewer') });
    const read = await app.inject({ method: 'PATCH', url: `/notifications/${notification.id}/read`, headers: authHeader(app, viewerId, 'viewer') });

    expect(list.statusCode).toBe(200);
    expect(read.statusCode).toBe(200);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/modules/notifications/notifications-api.test.ts`
Expected: FAIL — `GET /notifications` returns 404 "Route not found".

- [ ] **Step 3: Implement**

```typescript
// src/modules/notifications/notifications.schemas.ts
import { z } from 'zod';
import { paginationQuerySchema } from '../../shared/pagination';

export const notificationListQuerySchema = paginationQuerySchema.extend({
  isRead: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
});

export const notificationIdParamsSchema = z.object({ id: z.string().uuid() });

export const notificationResponseSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  relatedCaseId: z.string().nullable(),
  isRead: z.boolean(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});

export const notificationListResponseSchema = z.object({
  items: z.array(notificationResponseSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  unreadCount: z.number(),
});
```

```typescript
// src/modules/notifications/notifications.service.ts
import type { DataSource } from 'typeorm';
import { AppNotification } from './entities/notification.entity';
import { NotFoundError } from '../../shared/errors';
import { buildPaginatedResponse, paginationToSkipTake } from '../../shared/pagination';

export async function listNotifications(
  dataSource: DataSource,
  userId: string,
  query: { page: number; pageSize: number; isRead?: boolean },
) {
  const repo = dataSource.getRepository(AppNotification);
  const where = query.isRead === undefined ? { userId } : { userId, isRead: query.isRead };
  const { skip, take } = paginationToSkipTake(query);
  const [items, total] = await repo.findAndCount({ where, order: { createdAt: 'DESC', id: 'DESC' }, skip, take });
  // Independent of the isRead filter: this feeds the frontend's bell badge.
  const unreadCount = await repo.count({ where: { userId, isRead: false } });
  return { ...buildPaginatedResponse(items, total, query), unreadCount };
}

export async function markNotificationRead(dataSource: DataSource, userId: string, notificationId: string): Promise<AppNotification> {
  const repo = dataSource.getRepository(AppNotification);
  const notification = await repo.findOne({ where: { id: notificationId, userId } });
  if (!notification) {
    throw new NotFoundError('Notification not found');
  }
  if (!notification.isRead) {
    notification.isRead = true;
    notification.readAt = new Date();
    await repo.save(notification);
  }
  return notification;
}
```

```typescript
// src/modules/notifications/notifications.routes.ts
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AppNotification } from './entities/notification.entity';
import { listNotifications, markNotificationRead } from './notifications.service';
import {
  notificationIdParamsSchema,
  notificationListResponseSchema,
  notificationListQuerySchema,
  notificationResponseSchema,
} from './notifications.schemas';

export function serializeNotification(row: AppNotification) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    relatedCaseId: row.relatedCaseId,
    isRead: row.isRead,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export default async function notificationsRoutes(app: FastifyInstance): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get('/notifications', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Notifications'],
      security: [{ bearerAuth: [] }],
      querystring: notificationListQuerySchema,
      response: { 200: notificationListResponseSchema },
    },
  }, async (request) => {
    const result = await listNotifications(app.dataSource, request.user.id, request.query);
    return { ...result, items: result.items.map(serializeNotification) };
  });

  typedApp.patch('/notifications/:id/read', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['Notifications'],
      security: [{ bearerAuth: [] }],
      params: notificationIdParamsSchema,
      response: { 200: notificationResponseSchema },
    },
  }, async (request) => {
    const notification = await markNotificationRead(app.dataSource, request.user.id, request.params.id);
    return serializeNotification(notification);
  });
}
```

```typescript
// src/app.ts — add import and registration after app.register(documentsRoutes, ...);
import notificationsRoutes from './modules/notifications/notifications.routes';
// ...
  app.register(notificationsRoutes);
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules/notifications/notifications-api.test.ts && npx tsc --noEmit`
Expected: PASS (8 tests), `tsc` clean. Also run `npx vitest run test/integration/modules/audit` to confirm swagger/route registration still boots — expected PASS.

- [ ] **Step 5: Commit**

Create `decisions/notifications/task-07-in-app-api.md` and add one bullet to the top of the `## notifications` section in `decisions.md`.

```bash
git add src/modules/notifications/notifications.schemas.ts src/modules/notifications/notifications.service.ts src/modules/notifications/notifications.routes.ts src/app.ts test/integration/modules/notifications/notifications-api.test.ts decisions.md decisions/notifications/task-07-in-app-api.md
git commit -m "feat: GET /notifications and PATCH /notifications/:id/read"
```

---

### Task 8: Email dispatcher

**Files:**
- Create: `src/modules/notifications/email/email-dispatcher.ts`
- Test: `test/integration/modules/notifications/email-dispatcher.test.ts`

**Interfaces:**
- Consumes: `AppNotification`, `User`, `Mailer`, `RecordingMailer`, `seedNotification`.
- Produces: `MAX_EMAIL_ATTEMPTS = 5`; `RETRY_DELAYS_MINUTES = [1, 5, 15, 60]`; `dispatchPendingEmails(dataSource, mailer, options?: { batchSize?: number }): Promise<{ sent: number; retried: number; failed: number }>` (Task 9 appends `startEmailWorker` to this file).

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/notifications/email-dispatcher.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedNotification } from '../../helpers/seed-notification';
import { RecordingMailer } from '../../helpers/recording-mailer';
import { AppNotification } from '../../../../src/modules/notifications/entities/notification.entity';
import { dispatchPendingEmails } from '../../../../src/modules/notifications/email/email-dispatcher';

describe('dispatchPendingEmails', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  const past = () => new Date(Date.now() - 3_600_000);
  const future = () => new Date(Date.now() + 3_600_000);
  const reload = (id: string) => ds.getRepository(AppNotification).findOneByOrFail({ id });

  async function recipient(email?: string, isActive = true) {
    const userId = await seedUserWithRole(ds, 'requester', { email, isActive });
    return userId;
  }

  it('sends a due pending notification to the user\'s address and marks it sent', async () => {
    const mailer = new RecordingMailer();
    const userId = await recipient('claimant@algihaz.local');
    const notification = await seedNotification(ds, { userId, title: 'Subject here', body: 'Body here', emailNextAttemptAt: past() });

    const result = await dispatchPendingEmails(ds, mailer);

    expect(result).toEqual({ sent: 1, retried: 0, failed: 0 });
    expect(mailer.sent).toEqual([{ to: 'claimant@algihaz.local', subject: 'Subject here', text: 'Body here' }]);
    const row = await reload(notification.id);
    expect(row.emailStatus).toBe('sent');
    expect(row.emailAttempts).toBe(1);
    expect(row.emailSentAt).toBeInstanceOf(Date);
    expect(row.emailLastError).toBeNull();
  });

  it('does not send a notification whose next attempt is in the future, nor sent or failed rows', async () => {
    const mailer = new RecordingMailer();
    const userId = await recipient();
    await seedNotification(ds, { userId, title: 'later', emailNextAttemptAt: future() });
    await seedNotification(ds, { userId, title: 'already sent', emailStatus: 'sent', emailNextAttemptAt: past() });
    await seedNotification(ds, { userId, title: 'given up', emailStatus: 'failed', emailNextAttemptAt: past() });

    const result = await dispatchPendingEmails(ds, mailer);

    expect(result).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect(mailer.sent).toHaveLength(0);
  });

  it('on failure keeps the row pending, records the error, and schedules the retry about a minute out', async () => {
    const mailer = new RecordingMailer();
    mailer.failAlways();
    const userId = await recipient();
    const notification = await seedNotification(ds, { userId, emailNextAttemptAt: past() });

    const result = await dispatchPendingEmails(ds, mailer);

    expect(result).toEqual({ sent: 0, retried: 1, failed: 0 });
    const row = await reload(notification.id);
    expect(row.emailStatus).toBe('pending');
    expect(row.emailAttempts).toBe(1);
    expect(row.emailLastError).toBe('SMTP unavailable');
    const delayMs = row.emailNextAttemptAt.getTime() - Date.now();
    expect(delayMs).toBeGreaterThan(30_000);
    expect(delayMs).toBeLessThan(120_000);
  });

  it('does not retry before the backoff elapses, and recovers once the mail server does', async () => {
    const mailer = new RecordingMailer();
    mailer.failNext(1);
    const userId = await recipient();
    const notification = await seedNotification(ds, { userId, emailNextAttemptAt: past() });

    await dispatchPendingEmails(ds, mailer);
    const immediate = await dispatchPendingEmails(ds, mailer);

    expect(immediate).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect(mailer.sent).toHaveLength(0);

    await ds.getRepository(AppNotification).update(notification.id, { emailNextAttemptAt: past() });
    const later = await dispatchPendingEmails(ds, mailer);

    expect(later.sent).toBe(1);
    const row = await reload(notification.id);
    expect(row.emailStatus).toBe('sent');
    expect(row.emailAttempts).toBe(2);
  });

  it.each([
    { priorAttempts: 0, expectedMinutes: 1 },
    { priorAttempts: 1, expectedMinutes: 5 },
    { priorAttempts: 2, expectedMinutes: 15 },
    { priorAttempts: 3, expectedMinutes: 60 },
  ])('after failure number $priorAttempts + 1 the retry is $expectedMinutes minutes out', async ({ priorAttempts, expectedMinutes }) => {
    const mailer = new RecordingMailer();
    mailer.failAlways();
    const userId = await recipient();
    const notification = await seedNotification(ds, { userId, emailAttempts: priorAttempts, emailNextAttemptAt: past() });

    await dispatchPendingEmails(ds, mailer);

    const row = await reload(notification.id);
    expect(row.emailStatus).toBe('pending');
    expect(row.emailAttempts).toBe(priorAttempts + 1);
    const delayMinutes = (row.emailNextAttemptAt.getTime() - Date.now()) / 60_000;
    expect(delayMinutes).toBeGreaterThan(expectedMinutes - 0.75);
    expect(delayMinutes).toBeLessThan(expectedMinutes + 0.75);
  });

  it('marks the notification failed after the 5th failed attempt and stops retrying', async () => {
    const mailer = new RecordingMailer();
    mailer.failAlways();
    const userId = await recipient();
    const notification = await seedNotification(ds, { userId, emailAttempts: 4, emailNextAttemptAt: past() });

    const result = await dispatchPendingEmails(ds, mailer);

    expect(result).toEqual({ sent: 0, retried: 0, failed: 1 });
    const row = await reload(notification.id);
    expect(row.emailStatus).toBe('failed');
    expect(row.emailAttempts).toBe(5);
    expect(row.emailLastError).toBe('SMTP unavailable');
    expect((await dispatchPendingEmails(ds, mailer)).failed).toBe(0);
  });

  it('does not email a user who was deactivated after the notification was created, but keeps the in-app item', async () => {
    const mailer = new RecordingMailer();
    const userId = await recipient(undefined, false);
    const notification = await seedNotification(ds, { userId, emailNextAttemptAt: past() });

    const result = await dispatchPendingEmails(ds, mailer);

    expect(result).toEqual({ sent: 0, retried: 0, failed: 1 });
    expect(mailer.sent).toHaveLength(0);
    const row = await reload(notification.id);
    expect(row.emailStatus).toBe('failed');
    expect(row.emailLastError).toBe('recipient inactive');
    expect(row.isRead).toBe(false);
  });

  it('one failing send does not stop the other users\' emails, and never touches the in-app state', async () => {
    const mailer = new RecordingMailer();
    mailer.failNext(1);
    const first = await recipient('one@algihaz.local');
    const second = await recipient('two@algihaz.local');
    const a = await seedNotification(ds, { userId: first, title: 'first', createdAt: new Date(Date.now() - 2000), emailNextAttemptAt: past() });
    const b = await seedNotification(ds, { userId: second, title: 'second', createdAt: new Date(Date.now() - 1000), emailNextAttemptAt: past() });

    const result = await dispatchPendingEmails(ds, mailer);

    expect(result).toEqual({ sent: 1, retried: 1, failed: 0 });
    expect(mailer.sent.map((message) => message.to)).toEqual(['two@algihaz.local']);
    expect((await reload(a.id)).emailStatus).toBe('pending');
    expect((await reload(b.id)).emailStatus).toBe('sent');
    expect((await reload(a.id)).isRead).toBe(false);
  });

  it('honours the batch size', async () => {
    const mailer = new RecordingMailer();
    const userId = await recipient();
    for (let i = 0; i < 3; i += 1) {
      await seedNotification(ds, { userId, title: `n${i}`, createdAt: new Date(Date.now() - (3 - i) * 1000), emailNextAttemptAt: past() });
    }

    const result = await dispatchPendingEmails(ds, mailer, { batchSize: 2 });

    expect(result.sent).toBe(2);
    expect(mailer.sent.map((message) => message.subject)).toEqual(['n0', 'n1']);
    const [{ count }] = await ds.query(`SELECT COUNT(*)::int AS count FROM notifications WHERE "emailStatus" = 'pending'`);
    expect(count).toBe(1);
  });

  it('two workers running at once send every email exactly once', async () => {
    const mailer = new RecordingMailer();
    mailer.setDelay(40);
    const userId = await recipient();
    for (let i = 0; i < 4; i += 1) {
      await seedNotification(ds, { userId, title: `n${i}`, createdAt: new Date(Date.now() - (4 - i) * 1000), emailNextAttemptAt: past() });
    }

    const [a, b] = await Promise.all([dispatchPendingEmails(ds, mailer), dispatchPendingEmails(ds, mailer)]);

    expect(a.sent + b.sent).toBe(4);
    expect(mailer.sent.map((message) => message.subject).sort()).toEqual(['n0', 'n1', 'n2', 'n3']);
    const [{ count }] = await ds.query(`SELECT COUNT(*)::int AS count FROM notifications WHERE "emailStatus" = 'sent'`);
    expect(count).toBe(4);
  });
});
```

`seedUserWithRole` already accepts `email` and `isActive` overrides (see `test/integration/helpers/seed-user.ts`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/modules/notifications/email-dispatcher.test.ts`
Expected: FAIL — `Cannot find module '.../email-dispatcher'`.

- [ ] **Step 3: Implement**

```typescript
// src/modules/notifications/email/email-dispatcher.ts
import type { DataSource } from 'typeorm';
import { AppNotification } from '../entities/notification.entity';
import { User } from '../../users/entities/user.entity';
import type { Mailer } from './mailer';

export const MAX_EMAIL_ATTEMPTS = 5;
// Delay before the next try after the 1st, 2nd, 3rd and 4th failed attempt.
export const RETRY_DELAYS_MINUTES = [1, 5, 15, 60];
const DEFAULT_BATCH_SIZE = 10;

export type DispatchResult = { sent: number; retried: number; failed: number };

// Each notification is claimed and processed in its own short transaction with
// FOR UPDATE SKIP LOCKED, so concurrent workers never pick the same row and a
// crash can duplicate at most the single email that was in flight
// (at-least-once delivery). Eligibility and backoff use the database clock
// (now()), never the Node clock, so host/container clock drift cannot matter.
export async function dispatchPendingEmails(
  dataSource: DataSource,
  mailer: Mailer,
  options: { batchSize?: number } = {},
): Promise<DispatchResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const result: DispatchResult = { sent: 0, retried: 0, failed: 0 };

  for (let processed = 0; processed < batchSize; processed += 1) {
    const claimed = await dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AppNotification);
      const row = await repo
        .createQueryBuilder('n')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where('n."emailStatus" = :status', { status: 'pending' })
        .andWhere('n."emailNextAttemptAt" <= now()')
        .orderBy('n."createdAt"', 'ASC')
        .limit(1)
        .getOne();
      if (!row) {
        return false;
      }

      const user = await manager.getRepository(User).findOne({ where: { id: row.userId } });
      if (!user || !user.isActive) {
        await repo.update(row.id, { emailStatus: 'failed', emailLastError: 'recipient inactive' });
        result.failed += 1;
        return true;
      }

      try {
        await mailer.send({ to: user.email, subject: row.title, text: row.body });
        await repo.update(row.id, {
          emailStatus: 'sent',
          emailAttempts: row.emailAttempts + 1,
          emailSentAt: () => 'now()',
          emailLastError: null,
        });
        result.sent += 1;
      } catch (error) {
        const attempts = row.emailAttempts + 1;
        const message = error instanceof Error ? error.message : String(error);
        if (attempts >= MAX_EMAIL_ATTEMPTS) {
          await repo.update(row.id, { emailStatus: 'failed', emailAttempts: attempts, emailLastError: message });
          result.failed += 1;
        } else {
          const delayMinutes = RETRY_DELAYS_MINUTES[attempts - 1];
          await repo.update(row.id, {
            emailAttempts: attempts,
            emailLastError: message,
            emailNextAttemptAt: () => `now() + interval '${delayMinutes} minutes'`,
          });
          result.retried += 1;
        }
      }
      return true;
    });
    if (!claimed) {
      break;
    }
  }
  return result;
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules/notifications/email-dispatcher.test.ts && npx tsc --noEmit`
Expected: PASS (14 tests including the table cases), `tsc` clean. Run the file twice to check the concurrency test is stable. If `setOnLocked` or `.limit(1)` with a lock is rejected by the installed TypeORM version, find the smallest working equivalent (for example `.take(1)` or a raw `SELECT ... FOR UPDATE SKIP LOCKED` through `manager.query`), keep every behaviour above identical, and record the change precisely in your report.

- [ ] **Step 5: Commit**

Create `decisions/notifications/task-08-email-dispatcher.md` and add one bullet to the top of the `## notifications` section in `decisions.md`.

```bash
git add src/modules/notifications/email/email-dispatcher.ts test/integration/modules/notifications/email-dispatcher.test.ts decisions.md decisions/notifications/task-08-email-dispatcher.md
git commit -m "feat: durable email dispatcher with retries and backoff"
```

---

### Task 9: Email worker and server wiring

**Files:**
- Modify: `src/modules/notifications/email/email-dispatcher.ts`
- Modify: `src/server.ts`
- Test: `test/integration/modules/notifications/email-worker.test.ts`

**Interfaces:**
- Consumes: `dispatchPendingEmails`, `createMailerFromEnv`, `RecordingMailer`, `seedNotification`.
- Produces: `startEmailWorker(deps: { dataSource: DataSource; mailer: Mailer; intervalMs?: number; onError?: (error: unknown) => void }): { stop(): Promise<void> }` (default interval 10 000 ms; never runs two dispatches at once in one process).

- [ ] **Step 1: Write the failing test**

```typescript
// test/integration/modules/notifications/email-worker.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DataSource } from 'typeorm';
import { buildTestDataSource } from '../../helpers/test-data-source';
import { resetDatabase } from '../../helpers/reset-db';
import { seedUserWithRole } from '../../helpers/seed-user';
import { seedNotification } from '../../helpers/seed-notification';
import { RecordingMailer } from '../../helpers/recording-mailer';
import { startEmailWorker } from '../../../../src/modules/notifications/email/email-dispatcher';
import type { Mailer } from '../../../../src/modules/notifications/email/mailer';

describe('startEmailWorker', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = buildTestDataSource();
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.undoLastMigration();
    await ds.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(ds);
  });

  const past = () => new Date(Date.now() - 3_600_000);

  async function waitFor(condition: () => boolean, timeoutMs = 4000) {
    const started = Date.now();
    while (!condition()) {
      if (Date.now() - started > timeoutMs) {
        throw new Error('condition not met in time');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('sends pending emails on its own once started, and stops cleanly', async () => {
    const mailer = new RecordingMailer();
    const userId = await seedUserWithRole(ds, 'requester');
    await seedNotification(ds, { userId, title: 'picked up by the worker', emailNextAttemptAt: past() });

    const worker = startEmailWorker({ dataSource: ds, mailer, intervalMs: 20 });
    await waitFor(() => mailer.sent.length === 1);
    await worker.stop();

    expect(mailer.sent[0].subject).toBe('picked up by the worker');
    const [{ count }] = await ds.query(`SELECT COUNT(*)::int AS count FROM notifications WHERE "emailStatus" = 'sent'`);
    expect(count).toBe(1);
  });

  it('never runs two dispatches at once, even with a slow mail server and a short interval', async () => {
    const mailer = new RecordingMailer();
    mailer.setDelay(120);
    const userId = await seedUserWithRole(ds, 'requester');
    for (let i = 0; i < 3; i += 1) {
      await seedNotification(ds, { userId, title: `n${i}`, createdAt: new Date(Date.now() - (3 - i) * 1000), emailNextAttemptAt: past() });
    }

    const worker = startEmailWorker({ dataSource: ds, mailer, intervalMs: 10 });
    await waitFor(() => mailer.sent.length === 3, 6000);
    await worker.stop();

    expect(mailer.maxInFlight).toBe(1);
  });

  it('reports a dispatch error to onError and keeps running', async () => {
    const userId = await seedUserWithRole(ds, 'requester');
    await seedNotification(ds, { userId, emailNextAttemptAt: past() });
    const errors: unknown[] = [];
    let calls = 0;
    const exploding: Mailer = {
      async send() {
        calls += 1;
        throw new Error('boom');
      },
    };
    // A mailer failure is handled inside dispatchPendingEmails (retry bookkeeping);
    // to exercise the worker's own error path, close the data source under it.
    const brokenDataSource = { transaction: async () => { throw new Error('database unavailable'); } } as unknown as DataSource;

    const worker = startEmailWorker({ dataSource: brokenDataSource, mailer: exploding, intervalMs: 15, onError: (error) => errors.push(error) });
    await waitFor(() => errors.length >= 2);
    await worker.stop();

    expect((errors[0] as Error).message).toBe('database unavailable');
    expect(calls).toBe(0);
  });

  it('stop() waits for the in-flight run and no further runs start afterwards', async () => {
    const mailer = new RecordingMailer();
    mailer.setDelay(80);
    const userId = await seedUserWithRole(ds, 'requester');
    await seedNotification(ds, { userId, title: 'first', createdAt: new Date(Date.now() - 2000), emailNextAttemptAt: past() });

    const worker = startEmailWorker({ dataSource: ds, mailer, intervalMs: 10 });
    await waitFor(() => mailer.sent.length === 1);
    await worker.stop();
    await seedNotification(ds, { userId, title: 'after stop', emailNextAttemptAt: past() });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(mailer.sent.map((message) => message.subject)).toEqual(['first']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/modules/notifications/email-worker.test.ts`
Expected: FAIL — `startEmailWorker is not a function`.

- [ ] **Step 3: Implement the worker**

```typescript
// src/modules/notifications/email/email-dispatcher.ts — append at the end of the file
const DEFAULT_WORKER_INTERVAL_MS = 10_000;

export type EmailWorker = { stop(): Promise<void> };

// Polls for due emails. Never overlaps two runs in one process; a failing run is
// reported through onError and does not stop the worker. Started only by
// server.ts, never by buildApp, so tests drive dispatchPendingEmails directly.
export function startEmailWorker(deps: {
  dataSource: DataSource;
  mailer: Mailer;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}): EmailWorker {
  let running = false;
  let stopped = false;
  let current: Promise<unknown> = Promise.resolve();

  const timer = setInterval(() => {
    if (running || stopped) {
      return;
    }
    running = true;
    current = dispatchPendingEmails(deps.dataSource, deps.mailer)
      .catch((error) => deps.onError?.(error))
      .finally(() => {
        running = false;
      });
  }, deps.intervalMs ?? DEFAULT_WORKER_INTERVAL_MS);

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await current;
    },
  };
}
```

- [ ] **Step 4: Wire the server**

```typescript
// src/server.ts — add imports
import { createMailerFromEnv } from './modules/notifications/email/nodemailer-mailer';
import { startEmailWorker } from './modules/notifications/email/email-dispatcher';

// in main(): create the mailer next to the storage (fails fast on missing SMTP_HOST / MAIL_FROM)
  const mailer = createMailerFromEnv(env);

// after `const app = buildApp(AppDataSource, { storage, uploadConfig });`
  const emailWorker = startEmailWorker({
    dataSource: AppDataSource,
    mailer,
    onError: (error) => app.log.error(error, 'email dispatch failed'),
  });

// in the shutdown handler, stop the worker before closing the app and the data source
  const shutdown = async (): Promise<void> => {
    await emailWorker.stop();
    await app.close();
    await AppDataSource.destroy();
    process.exit(0);
  };
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run test/integration/modules/notifications/email-worker.test.ts && npx tsc --noEmit`
Expected: PASS (4 tests), `tsc` clean. Run the worker test file twice to check it is stable.

- [ ] **Step 6: Commit**

Create `decisions/notifications/task-09-email-worker-and-server.md` and add one bullet to the top of the `## notifications` section in `decisions.md`.

```bash
git add src/modules/notifications/email/email-dispatcher.ts src/server.ts test/integration/modules/notifications/email-worker.test.ts decisions.md decisions/notifications/task-09-email-worker-and-server.md
git commit -m "feat: email worker and server wiring for notification delivery"
```

---

## Final verification

After Task 9, run the whole backend suite on a genuinely fresh test container and the typecheck. The `-v` is required: the test Postgres uses a `tmpfs` data directory, so only a recreated container guarantees empty state.

```bash
docker compose -f docker-compose.test.yml down -v
docker compose -f docker-compose.test.yml up -d
sleep 4
npx vitest run test/unit test/integration
npx tsc --noEmit
```

Expected: all test files pass (previously 323 passed / 1 skipped across 66 files; this plan adds roughly 90 more tests and one more skipped smoke test), `tsc` clean. Optionally verify real SMTP delivery against MailHog: `docker compose -f docker-compose.dev.yml up -d mailhog` then `MAILHOG_SMOKE_TEST=1 npx vitest run test/integration/email`.
