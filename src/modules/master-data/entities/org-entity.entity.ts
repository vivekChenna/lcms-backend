import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('entities')
export class OrgEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', unique: true })
  name!: string;

  @Column({ type: 'varchar', unique: true })
  code!: string;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;
}
