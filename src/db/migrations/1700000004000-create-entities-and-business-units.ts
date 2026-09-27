import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

export class CreateEntitiesAndBusinessUnits1700000004000 implements MigrationInterface {
  name = 'CreateEntitiesAndBusinessUnits1700000004000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'entities',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'name', type: 'varchar', isUnique: true },
          { name: 'code', type: 'varchar', isUnique: true },
          { name: 'isActive', type: 'boolean', default: true },
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'business_units',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'entityId', type: 'uuid' },
          { name: 'name', type: 'varchar' },
          { name: 'isActive', type: 'boolean', default: true },
        ],
      }),
    );
    await queryRunner.createForeignKey(
      'business_units',
      new TableForeignKey({ columnNames: ['entityId'], referencedTableName: 'entities', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }),
    );

    await queryRunner.query(`
      INSERT INTO entities (name, code) VALUES
        ('AGC', 'AGC'), ('CCE', 'CCE'), ('Craft', 'CRAFT'), ('NewFab', 'NEWFAB'), ('SEP', 'SEP'),
        ('SELCO', 'SELCO'), ('Lamprell', 'LAMPRELL'), ('AIGC', 'AIGC'), ('AMC', 'AMC'), ('Enshore Subsea', 'ENSHORE')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('business_units');
    await queryRunner.dropTable('entities');
  }
}
