import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('closure_outcomes')
export class ClosureOutcome {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  name!: string;

  @Column({ default: true })
  isActive!: boolean;
}
