import { requireUser, assertSameOrigin } from '@/server/authorize';
import { withAccountScope } from '@/server/db';
import { failure, privateHeaders } from '@/server/http';
import { readSave, readSaveBody, writeSave } from '@/server/games/saves';

export const dynamic='force-dynamic';
export async function GET(request:Request) {
  try {
    const user=await requireUser(request.headers);
    return await withAccountScope(user.id,async()=>Response.json(await readSave(new URL(request.url).searchParams.get('metadata')==='1'),{headers:privateHeaders}));
  }catch(error){return failure(error);}
}
export async function PUT(request:Request) {
  try {
    const user=await requireUser(request.headers);assertSameOrigin(request);
    return await withAccountScope(user.id,async()=>Response.json(await writeSave(await readSaveBody(request)),{headers:privateHeaders}));
  }catch(error){return failure(error);}
}
