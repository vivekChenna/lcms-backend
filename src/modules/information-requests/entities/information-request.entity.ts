import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export type InformationRequestStatus = 'open' | 'answered' | 'superseded';

@Entity('information_requests')
export class InformationRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  caseId!: string;

  @Column({ type: 'varchar' })
  subject!: string;

  @Column({ type: 'varchar' })
  requirementDescription!: string;

  @Column({ type: 'uuid' })
  raisedById!: string;

  @Column({ type: 'uuid' })
  responderId!: string;

  @Column({ type: 'timestamptz', nullable: true })
  dueDate!: Date | null;

  @Column({ type: 'varchar', default: 'open' })
  status!: InformationRequestStatus;

  @Column({ type: 'varchar', nullable: true })
  responseText!: string | null;

  @Column({ type: 'uuid', nullable: true })
  reopenedFromId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
