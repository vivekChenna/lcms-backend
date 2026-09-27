import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('routing_rules')
export class RoutingRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'jsonb' })
  matchCriteria!: Record<string, unknown>;

  @Column({ type: 'uuid' })
  targetLegalRepId!: string;

  @Column({ type: 'int', default: 0 })
  priorityOrder!: number;

  @Column({ default: true })
  isActive!: boolean;
}
