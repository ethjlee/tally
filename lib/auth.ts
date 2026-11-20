import {
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  MIN_USERNAME_LENGTH,
  USERNAME_PATTERN
} from "./credentials";
import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins";
import { getPool } from "./db";
import { authOrigin, requireStrongSecret } from "./env";

function createTallyAuth(allowSignUp: boolean) {
  const origin = authOrigin();

  return betterAuth({
    appName: "Tally",
    database: getPool(),
    baseURL: origin,
    secret: requireStrongSecret("BETTER_AUTH_SECRET"),
    trustedOrigins: [origin],
    emailAndPassword: {
      enabled: true,
      disableSignUp: !allowSignUp,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      revokeSessionsOnPasswordReset: true
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/sign-in/username": {
          window: 60,
          max: 5
        },
        "/sign-in/email": {
          window: 60,
          max: 5
        }
      }
    },
    advanced: {
      useSecureCookies: process.env.NODE_ENV === "production",
      disableCSRFCheck: false,
      disableOriginCheck: false,
      cookiePrefix: "tally",
      defaultCookieAttributes: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/"
      }
    },
    plugins: [
      username({
        minUsernameLength: MIN_USERNAME_LENGTH,
        maxUsernameLength: MAX_USERNAME_LENGTH,
        usernameValidator: (value) => USERNAME_PATTERN.test(value)
      })
    ]
  });
}

type TallyAuth = ReturnType<typeof createTallyAuth>;
let ownerAuth: TallyAuth | undefined;
let bootstrapAuth: TallyAuth | undefined;

export function getAuth(): TallyAuth {
  return ownerAuth ??= createTallyAuth(false);
}

/** Used only by the token-protected, one-time owner bootstrap endpoint. */
export function getSetupAuth(): TallyAuth {
  return bootstrapAuth ??= createTallyAuth(true);
}
