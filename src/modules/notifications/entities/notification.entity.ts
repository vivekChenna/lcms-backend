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
