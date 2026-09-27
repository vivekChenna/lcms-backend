import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('business_units')
export class BusinessUnit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  entityId!: string;

  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;
}
