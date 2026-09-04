/**
 * Shared types. Nothing here describes a model payload — IFC/BCF/IDS types live
 * in `lib/ifc`, `lib/bcf` and `lib/ids` and never cross a network boundary.
 */

export type SelectOption = {
  value: string | number;
  label: string;
};

/** SimpleJWT token pair, as issued by the Django `core` app. */
export type AuthTokens = {
  access: string;
  refresh: string;
};

/** Claims added by `core.auth.MyTokenObtainPairSerializer`. */
export type JwtPayload = {
  token_type: "access" | "refresh";
  exp: number;
  iat: number;
  jti: string;
  user_id: number;
  is_staff: boolean;
  roles: string[];
};

/** djoser `auth/users/me/` shape (see `core.serializers.UserSerializer`). */
export type User = {
  id: number;
  email: string;
  first_name?: string;
  last_name?: string;
  is_staff?: boolean;
  groups?: string[];
};

export type ProjectRole = "owner" | "manager" | "contributor" | "viewer";

export type Project = {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  role: ProjectRole;
};

/**
 * Audit row written by the browser on an explicit opt-in. Deliberately carries
 * no file content and no signature value — see AGENTS.md §1.
 */
export type SignatureAudit = {
  id: string;
  project: string | null;
  file_name: string;
  digest_hex: string;
  cert_subject: string;
  cert_serial: string;
  signed_at: string;
};
