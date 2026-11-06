import { assertSameOrigin, requireUser } from '../authorize';
import { withAccountScope } from '../db';
import { failure, privateHeaders } from '../http';

export async function conversionRequest(request: Request, action: () => Promise<Response>): Promise<Response> {
  try {
    const user = await requireUser(request.headers);
    assertSameOrigin(request);
    return await withAccountScope(user.id, action);
  } catch (error) { return failure(error); }
}
export const conversionJson = (body: unknown, status = 200) => Response.json(body, { status, headers: privateHeaders });
