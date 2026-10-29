// API Response Types
export interface ApiResponse<T = any> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
  status?: number;
}

// Auth Types
export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface LoginRequest {
  username: string;
  password: string;
  turnstile_token?: string;
}

export interface RegisterRequest {
  username: string;
  password: string;
  turnstile_token?: string;
}

export interface RefreshTokenRequest {
  refresh_token: string;
}

export interface LogoutResponse {
  revoked_count: number;
}

// Session Types
export interface Session {
  session_id: string;
  device_info: string;
  ip_address: string;
  created_at: string;
  last_used_at: string;
  is_current: boolean;
}

export interface SessionsResponse {
  current_session_id: string;
  sessions: Session[];
}

export interface RevokeSessionRequest {
  password: string;
}

// User Data Types
export interface SetSecurityPasswordRequest {
  password: string;
}

export interface UpdateSecurityPasswordRequest {
  old_password: string;
  new_password: string;
}

export interface SecurityPasswordStatusResponse {
  has_security_password: boolean;
}

export interface GetUserDataRequest {
  password?: string;
}

export interface UserDataResponse {
  data: any;
  is_encrypted: boolean;
  /** Server revision of the snapshot (D1 backend; absent on older servers). */
  revision?: number;
}

export interface UpdateUserDataRequest {
  password?: string;
  data: any;
  /** Revision the upload is based on; a stale one is refused with 409. */
  base_revision?: number;
}

// Share Types
export type ShareType = 'realtime' | 'copy';

export interface CreateShareRequest {
  share_type: ShareType;
  password?: string;
  security_password?: string;
  max_attempts?: number;
}

export interface CreateShareResponse {
  share_id: string;
  share_type: ShareType;
}

export interface Share {
  share_id: string;
  share_type: ShareType;
  has_password: boolean;
  view_count: number;
  attempt_count: number;
  max_attempts: number;
  is_locked: boolean;
  created_at: string;
}

export interface UpdateSharePasswordRequest {
  password: string;
}

export interface UpdateShareLockRequest {
  max_attempts: number;
}

export interface ViewShareRequest {
  password?: string;
}

export interface ViewShareResponse {
  data: any;
  share_type: ShareType;
}

// Avatar Types
export interface UploadAvatarResponse {
  avatar: string;
  original_size: number;
  final_size: number;
  compressed: boolean;
}

// Password Management Types
export interface ChangePasswordRequest {
  old_password: string;
  new_password: string;
}

export interface ChangePasswordResponse {
  message: string;
  other_sessions_logged_out: number;
}

// Statistics Types
export interface StatisticsResponse {
  total_users: number;
  data_syncs_last_7days: number;
  database_size_mb: number;
  last_updated_at: string;
}

// OIDC Types
export interface OIDCConfig {
  oidc_enabled: boolean;
  registration_disabled: boolean;
}

export interface OIDCAuthorizeResponse {
  auth_url: string;
  state: string;
}

export interface OIDCCallbackRequest {
  code: string;
  state: string;
}

export interface OIDCCallbackResponse {
  tokens: AuthTokens;
  is_new_user: boolean;
  username?: string;
  display_name?: string;
  avatar_url?: string;
}

export interface OIDCBindStatusResponse {
  bound: boolean;
  oidc_subject?: string;
  oidc_email?: string;
  provider?: string;
  has_password: boolean;
}

export interface SetLoginPasswordRequest {
  password: string;
}

export interface RemoveLoginPasswordRequest {
  password: string;
}

export interface UserMeResponse {
  username: string;
  user_id: number;
  /** D1 backend: false for accounts created with Google sign-in. */
  has_password?: boolean;
  /** D1 backend profile (see UserProfile). */
  display_name?: string;
  avatar_url?: string | null;
  has_custom_avatar?: boolean;
  google_avatar_url?: string | null;
  greet?: boolean;
}

/** D1 backend: the user's editable profile. */
export interface UserProfile {
  display_name: string;
  /** Custom avatar (data URL) or the Google photo; null when neither. */
  avatar_url: string | null;
  has_custom_avatar: boolean;
  /** The Google photo (what "use Google photo" falls back to). */
  google_avatar_url: string | null;
  /** Greet the user by name on the overview. */
  greet: boolean;
}

export interface UpdateProfileRequest {
  display_name?: string;
  /** Data URL, or null to fall back to the Google photo. */
  avatar?: string | null;
  greet?: boolean;
}
