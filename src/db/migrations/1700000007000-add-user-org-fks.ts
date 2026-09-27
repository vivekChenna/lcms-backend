import { MigrationInterface, QueryRunner, TableForeignKey } from 'typeorm';

// users.departmentId/entityId/businessUnitId were nullable uuid columns with
// no FK since Task 8 (users table) predates departments/entities/business_units
// (Tasks 21/23) — added here, after all referenced tables exist, as
// defense-in-depth alongside the app-layer validation in createUser
// (code review finding, Phase 1 fix pass).
export class AddUserOrgFks1700000007000 implements MigrationInterface {
  name = 'AddUserOrgFks1700000007000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createForeignKey(
      'users',
      new TableForeignKey({ columnNames: ['departmentId'], referencedTableName: 'departments', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }),
    );
    await queryRunner.createForeignKey(
      'users',
      new TableForeignKey({ columnNames: ['entityId'], referencedTableName: 'entities', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }),
    );
    await queryRunner.createForeignKey(
      'users',
      new TableForeignKey({ columnNames: ['businessUnitId'], referencedTableName: 'business_units', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('users');
    if (!table) return;
    for (const columnName of ['departmentId', 'entityId', 'businessUnitId']) {
      const fk = table.foreignKeys.find((f) => f.columnNames.includes(columnName));
      if (fk) await queryRunner.dropForeignKey('users', fk);
    }
  }
}
