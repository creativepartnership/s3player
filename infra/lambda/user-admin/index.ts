import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUpdateUserAttributesCommand,
  AttributeType,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  UserType,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';

/**
 * User management for the app's Admin › Users page, invoked directly by
 * admins (only the Admins IAM role may invoke it). The rules live here, not
 * in the browser, so they hold whatever a client sends:
 *
 * - accounts are created and changed only as viewers (Users) or uploaders
 *   (Uploaders), never as admins;
 * - admin accounts can't be changed, disabled or deleted from here (create
 *   and manage those with scripts/add-user.sh / the Cognito console).
 */

const ADMINS = 'Admins';
const ROLE_GROUPS = { viewer: 'Users', uploader: 'Uploaders' } as const;
type Role = keyof typeof ROLE_GROUPS | 'admin';

export interface UserSummary {
  username: string;
  email: string;
  name: string;
  role: Role;
  categories: string[];
  /** May use the Download buttons (admins always can). */
  canDownload: boolean;
  /** Cognito: CONFIRMED, FORCE_CHANGE_PASSWORD (invited), … */
  status: string;
  enabled: boolean;
  createdAt: string | null;
}

export type UserAdminRequest =
  | { action: 'list' }
  | { action: 'invite'; email: string; name?: string; role: 'viewer' | 'uploader'; categories: string[]; canDownload?: boolean }
  | { action: 'update'; username: string; name?: string; role: 'viewer' | 'uploader'; categories: string[]; canDownload?: boolean }
  | { action: 'setEnabled'; username: string; enabled: boolean }
  | { action: 'resendInvite'; username: string }
  | { action: 'delete'; username: string };

export type UserAdminResponse =
  | { ok: true; users?: UserSummary[]; user?: UserSummary }
  | { ok: false; error: 'adminProtected' | 'exists' | 'invalid' | 'notFound' | 'failed'; message: string };

const cognito = new CognitoIdentityProviderClient({});
const poolId = () => {
  const id = process.env['USER_POOL_ID'];
  if (!id) {
    throw new Error('USER_POOL_ID is not set.');
  }
  return id;
};

export async function handler(request: UserAdminRequest): Promise<UserAdminResponse> {
  try {
    switch (request.action) {
      case 'list':
        return { ok: true, users: await listUsers() };
      case 'invite':
        return { ok: true, user: await invite(request) };
      case 'update':
        await assertNotAdmin(request.username);
        return { ok: true, user: await update(request) };
      case 'setEnabled':
        await assertNotAdmin(request.username);
        await cognito.send(
          request.enabled
            ? new AdminEnableUserCommand({ UserPoolId: poolId(), Username: request.username })
            : new AdminDisableUserCommand({ UserPoolId: poolId(), Username: request.username }),
        );
        return { ok: true };
      case 'resendInvite':
        await assertNotAdmin(request.username);
        await cognito.send(
          new AdminCreateUserCommand({ UserPoolId: poolId(), Username: request.username, MessageAction: 'RESEND', DesiredDeliveryMediums: ['EMAIL'] }),
        );
        return { ok: true };
      case 'delete':
        await assertNotAdmin(request.username);
        await cognito.send(new AdminDeleteUserCommand({ UserPoolId: poolId(), Username: request.username }));
        return { ok: true };
      default:
        return fail('invalid', 'Unknown action.');
    }
  } catch (err) {
    if (err instanceof RuleError) {
      return fail(err.code, err.message);
    }
    if (err instanceof UsernameExistsException) {
      return fail('exists', 'An account with this email already exists.');
    }
    if (err instanceof Error && err.name === 'UserNotFoundException') {
      return fail('notFound', 'No such user.');
    }
    console.error(err);
    return fail('failed', err instanceof Error ? err.message : 'Failed.');
  }
}

class RuleError extends Error {
  constructor(
    readonly code: 'adminProtected' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

function fail(error: Extract<UserAdminResponse, { ok: false }>['error'], message: string): UserAdminResponse {
  return { ok: false, error, message };
}

// ---------------------------------------------------------------------------

async function listUsers(): Promise<UserSummary[]> {
  const roleOf = new Map<string, Role>();
  for (const [role, group] of [['admin', ADMINS], ['uploader', ROLE_GROUPS.uploader], ['viewer', ROLE_GROUPS.viewer]] as const) {
    let token: string | undefined;
    do {
      const page = await cognito.send(new ListUsersInGroupCommand({ UserPoolId: poolId(), GroupName: group, NextToken: token }));
      for (const u of page.Users ?? []) {
        // Highest privilege wins if someone is in more than one group.
        if (u.Username && !roleOf.has(u.Username)) {
          roleOf.set(u.Username, role);
        }
      }
      token = page.NextToken;
    } while (token);
  }
  const users: UserSummary[] = [];
  let token: string | undefined;
  do {
    const page = await cognito.send(new ListUsersCommand({ UserPoolId: poolId(), PaginationToken: token }));
    for (const u of page.Users ?? []) {
      users.push(summarize(u, roleOf.get(u.Username ?? '') ?? 'viewer'));
    }
    token = page.PaginationToken;
  } while (token);
  return users.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
}

async function invite(request: Extract<UserAdminRequest, { action: 'invite' }>): Promise<UserSummary> {
  const email = request.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new RuleError('invalid', 'Not a valid email address.');
  }
  const group = groupFor(request.role);
  const attributes: AttributeType[] = [
    { Name: 'email', Value: email },
    { Name: 'email_verified', Value: 'true' },
    { Name: 'custom:categories', Value: cleanCategories(request.categories).join(',') },
    { Name: 'custom:download', Value: request.canDownload === true ? '1' : '' },
  ];
  if (request.name?.trim()) {
    attributes.push({ Name: 'name', Value: request.name.trim().slice(0, 80) });
  }
  const created = await cognito.send(
    new AdminCreateUserCommand({ UserPoolId: poolId(), Username: email, UserAttributes: attributes, DesiredDeliveryMediums: ['EMAIL'] }),
  );
  await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: poolId(), Username: email, GroupName: group }));
  return summarize(created.User ?? { Username: email, Attributes: attributes }, request.role);
}

async function update(request: Extract<UserAdminRequest, { action: 'update' }>): Promise<UserSummary> {
  const group = groupFor(request.role);
  const attributes: AttributeType[] = [
    { Name: 'custom:categories', Value: cleanCategories(request.categories).join(',') },
    { Name: 'custom:download', Value: request.canDownload === true ? '1' : '' },
  ];
  if (request.name !== undefined) {
    attributes.push({ Name: 'name', Value: request.name.trim().slice(0, 80) });
  }
  await cognito.send(new AdminUpdateUserAttributesCommand({ UserPoolId: poolId(), Username: request.username, UserAttributes: attributes }));
  // Exactly one role group.
  for (const other of Object.values(ROLE_GROUPS)) {
    if (other !== group) {
      await cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: poolId(), Username: request.username, GroupName: other }));
    }
  }
  await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: poolId(), Username: request.username, GroupName: group }));
  const users = await listUsers();
  const user = users.find((u) => u.username === request.username);
  if (!user) {
    throw new Error('UserNotFoundException');
  }
  return user;
}

async function assertNotAdmin(username: string): Promise<void> {
  if (!username) {
    throw new RuleError('invalid', 'No user given.');
  }
  const groups = await cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: poolId(), Username: username }));
  if (groups.Groups?.some((g) => g.GroupName === ADMINS)) {
    throw new RuleError('adminProtected', 'Administrator accounts can only be managed with scripts/add-user.sh or the Cognito console.');
  }
}

function groupFor(role: string): string {
  if (role === 'viewer' || role === 'uploader') {
    return ROLE_GROUPS[role];
  }
  // 'admin' or anything else: refused, by design.
  throw new RuleError('invalid', 'Users can only be viewers or uploaders here.');
}

/** Access codes: lowercase letters, digits, - and _; no duplicates. */
function cleanCategories(categories: unknown): string[] {
  if (!Array.isArray(categories)) {
    return [];
  }
  const clean = categories
    .filter((c): c is string => typeof c === 'string')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => /^[a-z0-9_-]{1,64}$/.test(c));
  return [...new Set(clean)];
}

function summarize(user: UserType, role: Role): UserSummary {
  const attr = (name: string) => user.Attributes?.find((a) => a.Name === name)?.Value ?? '';
  return {
    username: user.Username ?? '',
    email: attr('email') || user.Username || '',
    name: attr('name'),
    role,
    categories: attr('custom:categories')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean),
    canDownload: role === 'admin' || attr('custom:download') === '1',
    status: user.UserStatus ?? 'UNKNOWN',
    enabled: user.Enabled ?? true,
    createdAt: user.UserCreateDate ? new Date(user.UserCreateDate).toISOString() : null,
  };
}
