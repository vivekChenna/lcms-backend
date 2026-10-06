import { In, type DataSource, type EntityManager } from 'typeorm';
import { User } from '../modules/users/entities/user.entity';
import { UserRole } from '../modules/users/entities/user-role.entity';
import { Role } from '../modules/users/entities/role.entity';
import { Case } from '../modules/cases/entities/case.entity';

export type NameSource = DataSource | EntityManager;
export type UserName = { fullName: string; designation: string | null; role: string | null };
type MaybeId = string | null | undefined;

const unique = (ids: MaybeId[]): string[] => [...new Set(ids.filter((id): id is string => Boolean(id)))];

// One query for the whole set of ids. Ids that do not resolve are simply absent
// from the map, so callers fall back to null instead of failing.
export async function loadUserNames(source: NameSource, ids: MaybeId[]): Promise<Map<string, UserName>> {
  const list = unique(ids);
  const result = new Map<string, UserName>();
  if (list.length === 0) {
    return result;
  }
  const rows = await source
    .getRepository(User)
    .createQueryBuilder('u')
    .leftJoin(UserRole, 'ur', 'ur."userId" = u.id')
    .leftJoin(Role, 'role', 'role.id = ur."roleId"')
    .select('u.id', 'id')
    .addSelect('u."fullName"', 'fullName')
    .addSelect('u.designation', 'designation')
    .addSelect('role.name', 'role')
    .where('u.id IN (:...ids)', { ids: list })
    .getRawMany<{ id: string; fullName: string; designation: string | null; role: string | null }>();
  for (const row of rows) {
    result.set(row.id, { fullName: row.fullName, designation: row.designation, role: row.role });
  }
  return result;
}

export async function loadNamesById(
  source: NameSource,
  entity: new () => { id: string; name: string },
  ids: MaybeId[],
): Promise<Map<string, string>> {
  const list = unique(ids);
  const result = new Map<string, string>();
  if (list.length === 0) {
    return result;
  }
  const rows = await source.getRepository(entity).find({ where: { id: In(list) } as never });
  for (const row of rows) {
    result.set(row.id, row.name);
  }
  return result;
}

export async function loadCaseReferences(source: NameSource, ids: MaybeId[]): Promise<Map<string, string>> {
  const list = unique(ids);
  const result = new Map<string, string>();
  if (list.length === 0) {
    return result;
  }
  const rows = await source.getRepository(Case).find({ where: { id: In(list) }, select: { id: true, referenceNumber: true } });
  for (const row of rows) {
    result.set(row.id, row.referenceNumber);
  }
  return result;
}
