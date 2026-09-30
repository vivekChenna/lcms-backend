import { MigrationInterface, QueryRunner, TableUnique } from 'typeorm';

// refresh_tokens.tokenHash had no index at all, so every refresh and every
// logout (a lookup by tokenHash) ran a sequential scan — on every active
// session, roughly every 15 minutes, against a table that only ever grows
// (nothing prunes revoked/expired rows). A unique constraint gives the
// lookup an index and also encodes the real invariant: a sha256 hash
// collision between two distinct tokens is cryptographically implausible,
// so two rows sharing a tokenHash would indicate a bug, not a valid state
// (code review finding, Phase 1 fix pass).
export class AddRefreshTokenHashIndex1700000009000 implements MigrationInterface {
  name = 'AddRefreshTokenHashIndex1700000009000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createUniqueConstraint(
      'refresh_tokens',
      new TableUnique({ name: 'UQ_refresh_tokens_token_hash', columnNames: ['tokenHash'] }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropUniqueConstraint('refresh_tokens', 'UQ_refresh_tokens_token_hash');
  }
}
