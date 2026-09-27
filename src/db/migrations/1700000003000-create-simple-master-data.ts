import { MigrationInterface, QueryRunner, Table } from 'typeorm';

const SIMPLE_TABLES = ['departments', 'case_categories', 'closure_outcomes'];

export class CreateSimpleMasterData1700000003000 implements MigrationInterface {
  name = 'CreateSimpleMasterData1700000003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const tableName of SIMPLE_TABLES) {
      await queryRunner.createTable(
        new Table({
          name: tableName,
          columns: [
            { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
            { name: 'name', type: 'varchar', isUnique: true },
            { name: 'isActive', type: 'boolean', default: true },
          ],
        }),
      );
    }

    await queryRunner.query(
      `INSERT INTO case_categories (name) VALUES ('Najiz'), ('Baladi Violation'), ('HR Termination'), ('Internal')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const tableName of [...SIMPLE_TABLES].reverse()) {
      await queryRunner.dropTable(tableName);
    }
  }
}
