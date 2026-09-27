import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('case_categories')
export class CaseCategory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', unique: true })
  name!: string;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;
}
