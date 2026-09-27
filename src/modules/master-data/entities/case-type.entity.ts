import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('case_types')
export class CaseType {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  categoryId!: string;

  @Column()
  name!: string;

  @Column({ type: 'varchar', nullable: true })
  description!: string | null;

  @Column({ type: 'int' })
  slaAckHours!: number;

  @Column({ type: 'int' })
  slaResolutionHours!: number;

  @Column({ default: true })
  isActive!: boolean;
}
