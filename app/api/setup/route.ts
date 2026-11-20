import {
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  MIN_USERNAME_LENGTH,
  USERNAME_PATTERN,
  setupTokensMatch
} from "../../../lib/credentials";
import { z } from "zod";
import { getSetupAuth } from "../../../lib/auth";
import { ownerExists } from "../../../lib/db";
import {
  privateJson,
  readLimitedJson,
  sameOrigin
} from "../../../lib/http";
import { requireStrongSecret } from "../../../lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const setupSchema = z.object({
  setupToken: z.string().min(32).max(512),
  username: z.string().min(MIN_USERNAME_LENGTH).max(MAX_USERNAME_LENGTH).regex(USERNAME_PATTERN),
  email: z.email().max(254),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH)
}).strict();

export async function GET() {
  try {
    return privateJson({ configured: await ownerExists() });
  } catch {
    return privateJson(
      { configured: false, migrationRequired: true },
      { status: 503 }
    );
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return privateJson({ error: "REQUEST_REJECTED" }, { status: 403 });
  }

  let body: z.infer<typeof setupSchema>;
  try {
    body = setupSchema.parse(await readLimitedJson(request, 8 * 1024));
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "PAYLOAD_TOO_LARGE";
    return privateJson(
      { error: tooLarge ? "PAYLOAD_TOO_LARGE" : "INVALID_SETUP_REQUEST" },
      { status: tooLarge ? 413 : 400 }
    );
  }

  try {
    if (await ownerExists()) {
      return privateJson({ error: "SETUP_ALREADY_COMPLETE" }, { status: 409 });
    }
    if (!setupTokensMatch(body.setupToken, requireStrongSecret("TALLY_SETUP_TOKEN"))) {
      return privateJson({ error: "INVALID_SETUP_CREDENTIALS" }, { status: 403 });
    }

    await getSetupAuth().api.signUpEmail({
      headers: request.headers,
      body: {
        name: body.username,
        email: body.email.toLowerCase(),
        password: body.password,
        username: body.username,
        displayUsername: body.username
      }
    });

    return privateJson({ success: true }, { status: 201 });
  } catch {
    // The database trigger is the final authority if two setup requests race.
    if (await ownerExists().catch(() => false)) {
      return privateJson({ error: "SETUP_ALREADY_COMPLETE" }, { status: 409 });
    }
    return privateJson({ error: "SETUP_FAILED" }, { status: 500 });
  }
}
