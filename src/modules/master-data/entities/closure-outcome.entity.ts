import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('closure_outcomes')
export class ClosureOutcome {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', unique: true })
  name!: string;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;
}
