import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

export class CreateNotifications1700000013000 implements MigrationInterface {
  name = 'CreateNotifications1700000013000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'notifications',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'userId', type: 'uuid' },
          { name: 'type', type: 'varchar' },
          { name: 'title', type: 'varchar' },
          { name: 'body', type: 'text' },
          { name: 'relatedCaseId', type: 'uuid', isNullable: true },
          { name: 'isRead', type: 'boolean', default: false },
          { name: 'readAt', type: 'timestamptz', isNullable: true },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
          { name: 'emailStatus', type: 'varchar', default: `'pending'` },
          { name: 'emailAttempts', type: 'integer', default: 0 },
          { name: 'emailNextAttemptAt', type: 'timestamptz', default: 'now()' },
          { name: 'emailSentAt', type: 'timestamptz', isNullable: true },
          { name: 'emailLastError', type: 'text', isNullable: true },
        ],
      }),
    );
    await queryRunner.createForeignKey('notifications', new TableForeignKey({ columnNames: ['userId'], referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('notifications', new TableForeignKey({ columnNames: ['relatedCaseId'], referencedTableName: 'cases', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createIndex('notifications', new TableIndex({ name: 'IDX_notifications_user_read_created', columnNames: ['userId', 'isRead', 'createdAt'] }));
    await queryRunner.createIndex('notifications', new TableIndex({ name: 'IDX_notifications_pending_email', columnNames: ['emailNextAttemptAt'], where: `"emailStatus" = 'pending'` }));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('notifications');
  }
}
