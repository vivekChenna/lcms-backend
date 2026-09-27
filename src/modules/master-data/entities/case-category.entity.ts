import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('case_categories')
export class CaseCategory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  name!: string;

  @Column({ default: true })
  isActive!: boolean;
}
