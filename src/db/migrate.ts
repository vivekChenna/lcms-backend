import 'reflect-metadata';
import { AppDataSource } from './data-source';

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'run' && command !== 'revert') {
    console.error('Usage: tsx src/db/migrate.ts <run|revert>');
    process.exit(1);
  }

  await AppDataSource.initialize();
  if (command === 'run') {
    const applied = await AppDataSource.runMigrations();
    console.log(`Applied ${applied.length} migration(s).`);
  } else {
    await AppDataSource.undoLastMigration();
    console.log('Reverted the last migration.');
  }
  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
