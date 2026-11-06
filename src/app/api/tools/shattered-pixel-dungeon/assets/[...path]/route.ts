import { open, realpath } from 'node:fs/promises';
import { resolve, relative, extname, sep, isAbsolute } from 'node:path';
import { requireUser } from '@/server/authorize';
import { DomainError } from '@/server/domain';
import { failure } from '@/server/http';
import { GAME_FRAME_CSP } from '@/server/games/security';

export const dynamic='force-dynamic';
export const runtime='nodejs';
const types:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.wasm':'application/wasm','.json':'application/json','.txt':'text/plain; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.mp3':'audio/mpeg','.ogg':'audio/ogg','.wav':'audio/wav','.css':'text/css; charset=utf-8','.gz':'application/gzip'};
type Context={params:Promise<{path:string[]}>};
async function serve(request:Request,{params}:Context,head=false) {
  try {
    await requireUser(request.headers);
    const parts=(await params).path;
    if(!parts.length||parts.some(p=>!p||p==='.'||p==='..'||/[\\/\0]/.test(p)))throw new DomainError('游戏资源不存在。',404);
    const root=await realpath(resolve('.games/shattered-pixel-dungeon-web')).catch((error:NodeJS.ErrnoException)=>{
      if(error.code==='ENOENT')throw new DomainError('游戏资源尚未构建，请管理员运行游戏构建命令。',503,'GAME_NOT_BUILT');
      throw error;
    });
    const target=await realpath(resolve(root,...parts));
    const rel=relative(root,target);
    if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new DomainError('游戏资源不存在。',404);
    const handle=await open(target,'r');
    const stat=await handle.stat().catch(async(error:unknown)=>{await handle.close();throw error;});
    if(!stat.isFile()){await handle.close();throw new DomainError('游戏资源不存在。',404);}
    const headers=new Headers({'Content-Type':types[extname(target)]??'application/octet-stream','Content-Length':String(stat.size),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
    if(parts.length===1&&parts[0]==='index.html') {
      headers.set('X-Frame-Options','SAMEORIGIN');
      headers.set('Content-Security-Policy',GAME_FRAME_CSP);
    }
    if(parts.at(-1)==='source.tar.gz')headers.set('Content-Disposition','attachment; filename="shattered-pixel-dungeon-source.tar.gz"');
    if(head){await handle.close();return new Response(null,{headers});}
    // Bounded reads with explicit cancellation avoid holding an open game bundle after navigation.
    let offset=0;let closed=false;
    const close=async()=>{if(!closed){closed=true;await handle.close();}};
    const body=new ReadableStream<Uint8Array>({
      async pull(controller){try{const buffer=Buffer.allocUnsafe(Math.min(256*1024,stat.size-offset));const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);if(!bytesRead){await close();controller.close();return;}offset+=bytesRead;controller.enqueue(new Uint8Array(buffer.subarray(0,bytesRead)));if(offset>=stat.size){await close();controller.close();}}catch(error){await close();controller.error(error);}},
      cancel:close,
    });
    return new Response(body,{headers});
  }catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT')return failure(new DomainError('游戏资源不存在。',404,'NOT_FOUND'));return failure(error);}
}
export const GET=(request:Request,context:Context)=>serve(request,context);
export const HEAD=(request:Request,context:Context)=>serve(request,context,true);
