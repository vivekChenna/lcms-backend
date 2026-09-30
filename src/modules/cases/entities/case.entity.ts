import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export type CaseStatus = 'Submitted' | 'Assigned' | 'In Progress' | 'Waiting on Input' | 'Closed';
export type CasePriority = 'P1' | 'P2' | 'P3' | 'P4';

@Entity('cases')
export class Case {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', unique: true })
  referenceNumber!: string;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'varchar' })
  description!: string;

  @Column({ type: 'boolean' })
  declarationConfirmed!: boolean;

  @Column({ type: 'uuid' })
  categoryId!: string;

  @Column({ type: 'uuid' })
  caseTypeId!: string;

  @Column({ type: 'uuid' })
  departmentId!: string;

  @Column({ type: 'uuid' })
  entityId!: string;

  @Column({ type: 'uuid', nullable: true })
  businessUnitId!: string | null;

  @Column({ type: 'varchar', default: 'P3' })
  priority!: CasePriority;

  @Column({ type: 'varchar', default: 'Submitted' })
  status!: CaseStatus;

  @Column({ type: 'boolean', default: false })
  isEscalated!: boolean;

  @Column({ type: 'varchar', nullable: true })
  escalationReason!: string | null;

  @Column({ type: 'varchar', nullable: true })
  waitingOnReason!: string | null;

  @Column({ type: 'uuid' })
  requesterId!: string;

  @Column({ type: 'uuid', nullable: true })
  assignedLegalRepId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  assignmentAcceptedAt!: Date | null;

  @Column({ type: 'timestamptz' })
  ackDueAt!: Date;

  @Column({ type: 'timestamptz' })
  resolutionDueAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  slaBreachNotifiedAt!: Date | null;

  @Column({ type: 'varchar', nullable: true })
  closureSummary!: string | null;

  @Column({ type: 'uuid', nullable: true })
  closureOutcomeId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  closedById!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
