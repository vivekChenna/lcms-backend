import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Admins no longer choose anyone's password: a user is created without one ("invited") and sets
 * their own through an emailed one-time link. That needs `users."passwordHash"` to be nullable and
 * a table for the links (only a hash of each token is stored).
 */
export class AddPasswordLinks1700000015000 implements MigrationInterface {
  name = 'AddPasswordLinks1700000015000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "passwordHash" DROP NOT NULL`);
    await queryRunner.createTable(
      new Table({
        name: 'password_links',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'userId', type: 'uuid' },
          { name: 'tokenHash', type: 'varchar', isUnique: true },
          { name: 'purpose', type: 'varchar' },
          { name: 'expiresAt', type: 'timestamptz' },
          // set when the link is used, or replaced by a newer one: either way it is dead
          { name: 'consumedAt', type: 'timestamptz', isNullable: true },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
        ],
      }),
    );
    await queryRunner.createForeignKey(
      'password_links',
      new TableForeignKey({ columnNames: ['userId'], referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }),
    );
    await queryRunner.createIndex('password_links', new TableIndex({ name: 'IDX_password_links_user_live', columnNames: ['userId'], where: '"consumedAt" IS NULL' }));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('password_links');
    // an invited user has no password yet; give them one nobody can match so the column can be NOT NULL again
    await queryRunner.query(`UPDATE "users" SET "passwordHash" = '!' WHERE "passwordHash" IS NULL`);
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "passwordHash" SET NOT NULL`);
  }
}
