import 'reflect-metadata';
import type { DataSource } from 'typeorm';
import { hashPassword } from '../shared/password';
import { User } from '../modules/users/entities/user.entity';
import { Role } from '../modules/users/entities/role.entity';
import { UserRole } from '../modules/users/entities/user-role.entity';

export async function seedAdmin(
  dataSource: DataSource,
  /** No password: the admin signs in through Drona, or sets one with the emailed link (forgot password). */
  options: { email: string; password?: string; fullName?: string },
): Promise<void> {
  const email = options.email.toLowerCase();
  const userRepo = dataSource.getRepository(User);
  const roleRepo = dataSource.getRepository(Role);
  const userRoleRepo = dataSource.getRepository(UserRole);

  const existing = await userRepo.findOne({ where: { email } });
  if (existing) {
    return;
  }

  const adminRole = await roleRepo.findOneOrFail({ where: { name: 'admin' } });
  const passwordHash = options.password ? await hashPassword(options.password) : null;
  const user = await userRepo.save(
    userRepo.create({ fullName: options.fullName ?? 'System Administrator', email, passwordHash, isActive: true }),
  );
  await userRoleRepo.save(userRoleRepo.create({ userId: user.id, roleId: adminRole.id }));
}

async function main(): Promise<void> {
  const { AppDataSource } = await import('./data-source.js');
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email) {
    console.error('ADMIN_EMAIL must be set');
    process.exit(1);
  }
  await AppDataSource.initialize();
  await seedAdmin(AppDataSource, { email, password, fullName: process.env.ADMIN_FULL_NAME });
  console.log(`Admin user ready: ${email.toLowerCase()}`);
  await AppDataSource.destroy();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
