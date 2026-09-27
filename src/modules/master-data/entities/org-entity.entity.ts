import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('entities')
export class OrgEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  name!: string;

  @Column({ unique: true })
  code!: string;

  @Column({ default: true })
  isActive!: boolean;
}
