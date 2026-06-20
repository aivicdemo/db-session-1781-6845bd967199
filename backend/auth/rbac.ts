import { APIGatewayProxyEvent } from 'aws-lambda';

export type UserRole = 'admin' | 'operator' | 'viewer';

export interface AuthContext {
  userId: string;
  role: UserRole;
  timestamp: number;
}

export interface RBACPolicy {
  [endpoint: string]: UserRole[];
}

const policies: RBACPolicy = {
  'GET /resources': ['admin', 'operator', 'viewer'],
  'POST /api/resources/bulk': ['admin', 'operator'],
  'POST /resources': ['admin', 'operator'],
  'PUT /resources': ['admin', 'operator'],
  'DELETE /resources': ['admin'],
};

export function extractAuthContext(event: APIGatewayProxyEvent): AuthContext {
  const authHeader = event.headers['Authorization'] || '';
  const roleHeader = event.headers['X-User-Role'] || 'viewer';
  const userIdHeader = event.headers['X-User-Id'] || 'unknown';

  const role = validateRole(roleHeader);

  return {
    userId: userIdHeader,
    role,
    timestamp: Date.now(),
  };
}

function validateRole(role: string): UserRole {
  const validRoles: UserRole[] = ['admin', 'operator', 'viewer'];
  if (validRoles.includes(role as UserRole)) {
    return role as UserRole;
  }
  return 'viewer';
}

export function checkPermission(method: string, path: string, role: UserRole): boolean {
  const endpoint = `${method} ${path}`;
  const allowedRoles = policies[endpoint];

  if (!allowedRoles) {
    return false;
  }

  return allowedRoles.includes(role);
}

export function requireRole(requiredRoles: UserRole[], userRole: UserRole): boolean {
  return requiredRoles.includes(userRole);
}