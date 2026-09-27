import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('case_types')
export class CaseType {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  categoryId!: string;

  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'varchar', nullable: true })
  description!: string | null;

  @Column({ type: 'int' })
  slaAckHours!: number;

  @Column({ type: 'int' })
  slaResolutionHours!: number;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;
}
