import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('audit_log')
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  caseId!: string | null;

  @Column({ type: 'uuid' })
  actorId!: string;

  @Column({ type: 'varchar' })
  action!: string;

  @Column({ type: 'jsonb', nullable: true })
  beforeValue!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  afterValue!: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt!: Date;
}
