import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

export class CreateDocumentsAndComments1700000012000 implements MigrationInterface {
  name = 'CreateDocumentsAndComments1700000012000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'documents',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'caseId', type: 'uuid' },
          { name: 'informationRequestId', type: 'uuid', isNullable: true },
          { name: 'filename', type: 'varchar' },
          { name: 'mimeType', type: 'varchar' },
          { name: 'sizeBytes', type: 'bigint' },
          { name: 'category', type: 'varchar' },
          { name: 'version', type: 'integer' },
          { name: 'rootDocumentId', type: 'uuid' },
          { name: 'previousVersionId', type: 'uuid', isNullable: true },
          { name: 'uploaderId', type: 'uuid' },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
          { name: 'deletedAt', type: 'timestamptz', isNullable: true },
        ],
      }),
    );
    await queryRunner.createForeignKey('documents', new TableForeignKey({ columnNames: ['caseId'], referencedTableName: 'cases', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('documents', new TableForeignKey({ columnNames: ['informationRequestId'], referencedTableName: 'information_requests', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('documents', new TableForeignKey({ columnNames: ['rootDocumentId'], referencedTableName: 'documents', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('documents', new TableForeignKey({ columnNames: ['previousVersionId'], referencedTableName: 'documents', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('documents', new TableForeignKey({ columnNames: ['uploaderId'], referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createIndex('documents', new TableIndex({ name: 'IDX_documents_caseId', columnNames: ['caseId'] }));
    await queryRunner.createIndex('documents', new TableIndex({ name: 'IDX_documents_rootDocumentId', columnNames: ['rootDocumentId'] }));

    await queryRunner.createTable(
      new Table({
        name: 'comments',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'caseId', type: 'uuid' },
          { name: 'authorId', type: 'uuid' },
          { name: 'body', type: 'text' },
          { name: 'isInternal', type: 'boolean', default: false },
          { name: 'createdAt', type: 'timestamptz', default: 'now()' },
          { name: 'updatedAt', type: 'timestamptz', default: 'now()' },
          { name: 'deletedAt', type: 'timestamptz', isNullable: true },
        ],
      }),
    );
    await queryRunner.createForeignKey('comments', new TableForeignKey({ columnNames: ['caseId'], referencedTableName: 'cases', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createForeignKey('comments', new TableForeignKey({ columnNames: ['authorId'], referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'RESTRICT' }));
    await queryRunner.createIndex('comments', new TableIndex({ name: 'IDX_comments_caseId', columnNames: ['caseId'] }));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('comments');
    await queryRunner.dropTable('documents');
  }
}
