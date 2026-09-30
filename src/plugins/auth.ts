import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadEnv } from '../config/env';
import { UnauthorizedError } from '../shared/errors';
import type { AuthenticatedUser } from '../shared/rbac';
import { User } from '../modules/users/entities/user.entity';
import { loadAuthenticatedUser } from '../modules/auth/auth.service';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    signAccessToken: (payload: AuthenticatedUser) => string;
  }
}

export default fp(async function authPlugin(app: FastifyInstance) {
  const env = loadEnv();

  await app.register(fastifyJwt, {
    secret: env.JWT_ACCESS_SECRET,
    sign: { expiresIn: env.JWT_ACCESS_EXPIRES_IN },
  });

  app.decorate('signAccessToken', (payload: AuthenticatedUser): string => {
    return app.jwt.sign(payload);
  });

  app.decorate('authenticate', async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    let decoded: AuthenticatedUser;
    try {
      decoded = await request.jwtVerify<AuthenticatedUser>();
    } catch {
      throw new UnauthorizedError('Missing or invalid access token');
    }

    // The access token's role/isActive are a snapshot from sign time, so a
    // deactivation or role change wouldn't take effect until the token
    // naturally expired. Re-checking against the current row on every
    // request makes both effects immediate (code review finding). A row
    // that no longer exists for this id (the user was hard-removed from
    // the DB out of band, or the token was forged/replayed against a row
    // that's since gone) fails closed rather than trusting the token's own
    // claims — a valid signature proves the token was genuinely issued, not
    // that the account it names still exists (code review finding).
    const user = await app.dataSource.getRepository(User).findOne({ where: { id: decoded.id } });
    if (!user) {
      throw new UnauthorizedError('Account no longer exists');
    }
    if (!user.isActive) {
      throw new UnauthorizedError('Account is deactivated');
    }
    request.user = await loadAuthenticatedUser(app.dataSource, user);
  });
});
