import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';
import type { DocumentCategory } from '../upload-config';

// pg returns bigint as a string; sizes are well inside Number's safe range.
const bigintToNumber = {
  to: (value: number | null) => value,
  from: (value: string | number | null) => (value === null ? null : Number(value)),
};

@Entity('documents')
export class CaseDocument {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  caseId!: string;

  @Column({ type: 'uuid', nullable: true })
  informationRequestId!: string | null;

  @Column({ type: 'varchar' })
  filename!: string;

  @Column({ type: 'varchar' })
  mimeType!: string;

  @Column({ type: 'bigint', transformer: bigintToNumber })
  sizeBytes!: number;

  @Column({ type: 'varchar' })
  category!: DocumentCategory;

  @Column({ type: 'integer' })
  version!: number;

  @Column({ type: 'uuid' })
  rootDocumentId!: string;

  @Column({ type: 'uuid', nullable: true })
  previousVersionId!: string | null;

  @Column({ type: 'uuid' })
  uploaderId!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
