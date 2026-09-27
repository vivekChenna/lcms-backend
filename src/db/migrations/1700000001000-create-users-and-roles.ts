import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

export class CreateUsersAndRoles1700000001000 implements MigrationInterface {
  name = 'CreateUsersAndRoles1700000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.createTable(
      new Table({
        name: 'roles',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'name', type: 'varchar', isUnique: true },
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'users',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'fullName', type: 'varchar' },
          { name: 'email', type: 'varchar', isUnique: true },
          { name: 'passwordHash', type: 'varchar' },
          { name: 'designation', type: 'varchar', isNullable: true },
          { name: 'phone', type: 'varchar', isNullable: true },
          { name: 'departmentId', type: 'uuid', isNullable: true },
          { name: 'entityId', type: 'uuid', isNullable: true },
          { name: 'businessUnitId', type: 'uuid', isNullable: true },
          { name: 'isActive', type: 'boolean', default: true },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
          { name: 'updatedAt', type: 'timestamptz', default: 'now()' },
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'user_roles',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'userId', type: 'uuid', isUnique: true },
          { name: 'roleId', type: 'uuid' },
          { name: 'assignedBy', type: 'uuid', isNullable: true },
          { name: 'assignedAt', type: 'timestamptz', default: 'now()' },
        ],
      }),
    );

    await queryRunner.createForeignKey(
      'user_roles',
      new TableForeignKey({ columnNames: ['userId'], referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'CASCADE' }),
    );
    await queryRunner.createForeignKey(
      'user_roles',
      new TableForeignKey({ columnNames: ['roleId'], referencedTableName: 'roles', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'refresh_tokens',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'userId', type: 'uuid' },
          { name: 'tokenHash', type: 'varchar' },
          { name: 'expiresAt', type: 'timestamptz' },
          { name: 'revokedAt', type: 'timestamptz', isNullable: true },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
        ],
      }),
    );
    await queryRunner.createForeignKey(
      'refresh_tokens',
      new TableForeignKey({ columnNames: ['userId'], referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'CASCADE' }),
    );

    await queryRunner.query(
      `INSERT INTO roles (name) VALUES ('admin'), ('legal_manager'), ('legal_rep'), ('requester'), ('viewer')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('refresh_tokens');
    await queryRunner.dropTable('user_roles');
    await queryRunner.dropTable('users');
    await queryRunner.dropTable('roles');
  }
}
