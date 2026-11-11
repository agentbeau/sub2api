import { handleS3, type ObjectStore } from "./s3.ts";

export const STATE_HOST = "r2.internal";
export const STATE_BUCKET = "state";

export async function handleR2Bridge(request: Request, store: ObjectStore): Promise<Response> {
  const url = new URL(request.url);
  const host = request.headers.get("host")?.toLowerCase();
  if (url.protocol !== "http:" || url.host !== STATE_HOST || (host !== undefined && host !== STATE_HOST && host !== `${STATE_HOST}:80`)) {
    return new Response("Forbidden", { status: 403 });
  }
  return handleS3(request, store, STATE_BUCKET);
}
