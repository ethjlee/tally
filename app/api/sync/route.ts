import { ZodError } from "zod";
import {
  privateJson,
  readLimitedJson,
  sameOrigin
} from "../../../lib/http";
import { requireSession } from "../../../lib/session";
import { getCloudState, putCloudState } from "../../../lib/state-store";
import { parseSnapshot, syncPutSchema } from "../../../lib/snapshot";
import { MAX_SYNC_BYTES } from "../../../shared/ledger-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { session, sessionHeaders } = await requireSession(request);
  if (!session) {
    return privateJson({ error: "UNAUTHORIZED" }, { status: 401, headers: sessionHeaders });
  }
  try {
    const state = await getCloudState(session.user.id);
    if (state.snapshot) parseSnapshot(state.snapshot);
    return privateJson(state, { headers: sessionHeaders });
  } catch {
    return privateJson({ error: "CLOUD_STATE_UNREADABLE" }, { status: 500, headers: sessionHeaders });
  }
}

export async function PUT(request: Request) {
  if (!sameOrigin(request)) {
    return privateJson({ error: "REQUEST_REJECTED" }, { status: 403 });
  }
  const { session, sessionHeaders } = await requireSession(request);
  const json = (body: unknown, status = 200) => privateJson(body, { status, headers: sessionHeaders });
  if (!session) {
    return json({ error: "UNAUTHORIZED" }, 401);
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
      return json(
        { error: "REVISION_CONFLICT", ...result.current },
        409
      );
    }
    return json(result);
  } catch (error) {
    if (error instanceof ZodError) {
      return json({ error: "INVALID_SNAPSHOT" }, 400);
    }
    if (error instanceof Error && error.message === "PAYLOAD_TOO_LARGE") {
      return json({ error: "PAYLOAD_TOO_LARGE" }, 413);
    }
    if (error instanceof Error && error.message === "INVALID_JSON") {
      return json({ error: "INVALID_JSON" }, 400);
    }
    return json({ error: "SYNC_FAILED" }, 500);
  }
}
