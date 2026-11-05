import { driveRequest } from './http';
import { getDrive } from './runtime';

export function downloadResponse(request: Request, id: string): Promise<Response> {
  return driveRequest(request, (owner) => getDrive().download(owner, id, request));
}
