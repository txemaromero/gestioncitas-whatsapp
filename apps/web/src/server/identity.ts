/**
 * F32: an email only grants something (claiming a clinic's invitation, the platform console) when
 * Kinde says it is verified (`email_verified` in the ID token). With the email code sign-in it
 * always is; a future social or password connection could return an unverified one.
 */
export function verifiedEmail(user: { email: string | null; emailVerified: boolean } | null | undefined): string | null {
  return user?.email && user.emailVerified ? user.email : null;
}
