export interface MemberAccount {
  id: string;
  username: string | null;
  name: string;
  role: 'owner' | 'member';
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AccountsResponse { accounts: MemberAccount[] }

export interface LoginEvent {
  id: string;
  userId: string | null;
  username: string | null;
  outcome: 'success' | 'failure';
  method: 'password' | 'totp' | 'backup-code';
  ipPrefix: string | null;
  userAgent: string;
  occurredAt: string;
}

export interface LoginEventPage {
  events: LoginEvent[];
  page: number;
  pageSize: number;
  total: number;
}
