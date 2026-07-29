import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { setupAuth } from "../../../lib/auth";
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
  username: z.string().min(3).max(30).regex(/^[A-Za-z0-9_]+$/),
  email: z.email().max(254),
  password: z.string().min(14).max(128)
}).strict();

function matchesSetupToken(candidate: string): boolean {
  const expected = Buffer.from(requireStrongSecret("TALLY_SETUP_TOKEN"), "utf8");
  const received = Buffer.from(candidate, "utf8");
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

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
    if (!matchesSetupToken(body.setupToken)) {
      return privateJson({ error: "INVALID_SETUP_CREDENTIALS" }, { status: 403 });
    }

    await setupAuth.api.signUpEmail({
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
