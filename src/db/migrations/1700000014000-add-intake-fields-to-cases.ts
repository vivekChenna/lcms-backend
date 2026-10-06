import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddIntakeFieldsToCases1700000014000 implements MigrationInterface {
  name = 'AddIntakeFieldsToCases1700000014000';

  private readonly columns = [
    new TableColumn({ name: 'isConfidential', type: 'boolean', default: false }),
    new TableColumn({ name: 'contactName', type: 'varchar', length: '200', isNullable: true }),
    new TableColumn({ name: 'contactEmail', type: 'varchar', length: '320', isNullable: true }),
    new TableColumn({ name: 'contactPhone', type: 'varchar', length: '50', isNullable: true }),
    new TableColumn({ name: 'desiredOutcome', type: 'text', isNullable: true }),
    new TableColumn({ name: 'incidentDate', type: 'date', isNullable: true }),
    new TableColumn({ name: 'businessDeadline', type: 'date', isNullable: true }),
    new TableColumn({ name: 'counterparty', type: 'varchar', length: '300', isNullable: true }),
    new TableColumn({ name: 'estimatedValue', type: 'numeric', precision: 14, scale: 2, isNullable: true }),
    new TableColumn({ name: 'thirdPartyDetails', type: 'text', isNullable: true }),
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns('cases', this.columns);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumns('cases', this.columns.map((column) => column.name));
  }
}
