import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('business_units')
export class BusinessUnit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  entityId!: string;

  @Column()
  name!: string;

  @Column({ default: true })
  isActive!: boolean;
}
