import { MigrationInterface, QueryRunner, TableUnique } from 'typeorm';

// case_types and business_units had no DB-level duplicate protection — the
// app-layer check-then-insert in their services is a TOCTOU race under
// concurrent requests. Adding the constraint here makes the central 23505
// mapping in error-handler.ts the backstop for both create and update
// (code review finding, Phase 1 fix pass).
export class AddMasterDataCompositeUniques1700000008000 implements MigrationInterface {
  name = 'AddMasterDataCompositeUniques1700000008000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createUniqueConstraint(
      'case_types',
      new TableUnique({ name: 'UQ_case_types_category_name', columnNames: ['categoryId', 'name'] }),
    );
    await queryRunner.createUniqueConstraint(
      'business_units',
      new TableUnique({ name: 'UQ_business_units_entity_name', columnNames: ['entityId', 'name'] }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropUniqueConstraint('case_types', 'UQ_case_types_category_name');
    await queryRunner.dropUniqueConstraint('business_units', 'UQ_business_units_entity_name');
  }
}
