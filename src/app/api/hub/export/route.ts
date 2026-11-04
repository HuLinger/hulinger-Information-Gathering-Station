import { requireOwner } from '../../../../server/authorize';
import { query } from '../../../../server/db';
import { DomainError } from '../../../../server/domain';
import { failure } from '../../../../server/http';
export const dynamic='force-dynamic';
export async function GET(request:Request) {
  try {
    await requireOwner(request.headers);
    const id=new URL(request.url).searchParams.get('id');
    const job=(await query<{status:string;payload:unknown;expires_at:Date}>('SELECT status,payload,expires_at FROM export_jobs WHERE id=$1',[id]))[0];
    if(!job)throw new DomainError('导出任务不存在',404);
    if(new Date(job.expires_at).getTime()<Date.now())throw new DomainError('文件已过期，请重新导出',410);
    if(job.status!=='completed')throw new DomainError('导出尚未完成，请稍后再试',409);
    return new Response(JSON.stringify(job.payload,null,2),{headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="hulinger-export-${id}.json"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
  }catch(error){return failure(error);}
}
