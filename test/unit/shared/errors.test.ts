import { describe, it, expect } from 'vitest';
import { AppError, NotFoundError, ForbiddenError, ValidationError, ConflictError, UnauthorizedError } from '../../../src/shared/errors';

describe('AppError hierarchy', () => {
  it('NotFoundError carries 404 and a code', () => {
    const e = new NotFoundError('Case not found');
    expect(e).toBeInstanceOf(AppError);
    expect(e.statusCode).toBe(404);
    expect(e.code).toBe('NOT_FOUND');
    expect(e.message).toBe('Case not found');
  });

  it('ForbiddenError carries 403', () => {
    expect(new ForbiddenError('nope').statusCode).toBe(403);
  });

  it('ValidationError carries 400 and optional details', () => {
    const e = new ValidationError('bad input', { field: 'title' });
    expect(e.statusCode).toBe(400);
    expect(e.details).toEqual({ field: 'title' });
  });

  it('ConflictError carries 409', () => {
    expect(new ConflictError('duplicate').statusCode).toBe(409);
  });

  it('UnauthorizedError carries 401', () => {
    expect(new UnauthorizedError('bad token').statusCode).toBe(401);
  });
});
