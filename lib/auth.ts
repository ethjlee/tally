import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins";
import { pool } from "./db";
import { authOrigin, requireStrongSecret } from "./env";

function createTallyAuth(allowSignUp: boolean) {
  const origin = authOrigin();

  return betterAuth({
    appName: "Tally",
    database: pool,
    baseURL: origin,
    secret: requireStrongSecret("BETTER_AUTH_SECRET"),
    trustedOrigins: [origin],
    emailAndPassword: {
      enabled: true,
      disableSignUp: !allowSignUp,
      minPasswordLength: 14,
      maxPasswordLength: 128,
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
        minUsernameLength: 3,
        maxUsernameLength: 30,
        usernameValidator: (value) => /^[A-Za-z0-9_]+$/.test(value)
      })
    ]
  });
}

/** Normal runtime auth: public account creation is permanently disabled. */
export const auth = createTallyAuth(false);

/** Used only by the token-protected, one-time owner bootstrap endpoint. */
export const setupAuth = createTallyAuth(true);
