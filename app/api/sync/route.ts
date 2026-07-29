import { ZodError } from "zod";
import {
  privateJson,
  readLimitedJson,
  sameOrigin
} from "../../../lib/http";
import { requireSession } from "../../../lib/session";
import { getCloudState, putCloudState } from "../../../lib/state-store";
import { parseSnapshot, syncPutSchema } from "../../../lib/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SYNC_BYTES = 5 * 1024 * 1024;

export async function GET(request: Request) {
  const session = await requireSession(request);
  if (!session) {
    return privateJson({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  try {
    const state = await getCloudState(session.user.id);
    if (state.snapshot) parseSnapshot(state.snapshot);
    return privateJson(state);
  } catch {
    return privateJson({ error: "CLOUD_STATE_UNREADABLE" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  if (!sameOrigin(request)) {
    return privateJson({ error: "REQUEST_REJECTED" }, { status: 403 });
  }
  const session = await requireSession(request);
  if (!session) {
    return privateJson({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  try {
    const parsed = syncPutSchema.parse(
      await readLimitedJson(request, MAX_SYNC_BYTES)
    );
    const result = await putCloudState(
      session.user.id,
      parsed.baseRevision,
      parsed.snapshot,
      parsed.operationId
    );

    if (result.status === "conflict") {
      return privateJson(
        { error: "REVISION_CONFLICT", ...result.current },
        { status: 409 }
      );
    }
    return privateJson(result);
  } catch (error) {
    if (error instanceof ZodError) {
      return privateJson({ error: "INVALID_SNAPSHOT" }, { status: 400 });
    }
    if (error instanceof Error && error.message === "PAYLOAD_TOO_LARGE") {
      return privateJson({ error: "PAYLOAD_TOO_LARGE" }, { status: 413 });
    }
    if (error instanceof Error && error.message === "INVALID_JSON") {
      return privateJson({ error: "INVALID_JSON" }, { status: 400 });
    }
    return privateJson({ error: "SYNC_FAILED" }, { status: 500 });
  }
}
