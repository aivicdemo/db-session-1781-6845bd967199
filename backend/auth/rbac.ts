import { APIGatewayProxyEvent } from 'aws-lambda';

export type Role = 'admin' | 'operator' | 'viewer';

export interface AuthContext {
  userId: string;
  role: Role;
  email: string;
}

export const ROLE_PERMISSIONS: Record<Role, Set<string>> = {
  admin: new Set([
    'GET_RESOURCES',
    'POST_BULK_IMPORT',
    'CREATE_RECORD',
    'UPDATE_RECORD',
    'DELETE_RECORD',
    'VALIDATE_DATA',
    'EXPORT_DATA',
    'APPROVE_BILLING',
  ]),
  operator: new Set([
    'GET_RESOURCES',
    'POST_BULK_IMPORT',
    'CREATE_RECORD',
    'UPDATE_RECORD',
    'VALIDATE_DATA',
    'EXPORT_DATA',
  ]),
  viewer: new Set([
    'GET_RESOURCES',
  ]),
};

export function extractAuthContext(event: APIGatewayProxyEvent): AuthContext {
  const authHeader = event.headers?.Authorization || event.headers?.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  
  // Mock token parsing - in production, verify JWT
  try {
    const decoded = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64').toString());
    return {
      userId: decoded.sub || 'unknown',
      role: (decoded.role || 'viewer') as Role,
      email: decoded.email || 'unknown@example.com',
    };
  } catch {
    return {
      userId: 'anonymous',
      role: 'viewer',
      email: 'anonymous@example.com',
    };
  }
}

export function hasPermission(auth: AuthContext, permission: string): boolean {
  return ROLE_PERMISSIONS[auth.role]?.has(permission) ?? false;
}

export function requirePermission(auth: AuthContext, permission: string): void {
  if (!hasPermission(auth, permission)) {
    throw new ForbiddenError(`Permission denied: ${permission}`);
  }
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}