import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

export const ROLE_NAMES = ['admin', 'legal_manager', 'legal_rep', 'requester', 'viewer'] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

@Entity('roles')
export class Role {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', unique: true })
  name!: RoleName;
}
