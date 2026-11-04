import { failure, privateHeaders as headers } from '../../../server/http';
import { requireOwner, assertSameOrigin } from '../../../server/authorize';
import { actionSchema, DomainError, executeDomain, getDetail, listHub } from '../../../server/domain';
import { query } from '../../../server/db';
import { createExport, listExports } from '../../../server/exports';
import { ensureSources, enqueueSource, validateSource } from '../../../server/collector/index';

export const dynamic='force-dynamic';
export async function GET(request:Request) {
  try {
    await requireOwner(request.headers);
    const params=new URL(request.url).searchParams;
    if(params.get('exports')==='1')return Response.json({exports:await listExports()},{headers});
    if(params.get('id'))return Response.json(await getDetail(params.get('id')!),{headers});
    await ensureSources();
    return Response.json(await listHub(params),{headers});
  } catch(error){return failure(error);}
}
async function boundedJson(request:Request) {
  if(!request.headers.get('content-type')?.includes('application/json'))throw new DomainError('需要 JSON 请求',415);
  const reader=request.body?.getReader();if(!reader)throw new DomainError('缺少请求内容');
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>256*1024){await reader.cancel();throw new DomainError('请求过大',413);}chunks.push(value);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new DomainError('JSON 格式无效');}
}
export async function POST(request:Request) {
  try {
    await requireOwner(request.headers);assertSameOrigin(request);
    const action=actionSchema.parse(await boundedJson(request));
    if(action.action==='sync'){await enqueueSource(action.id);return Response.json({ok:true},{headers});}
    if(action.action==='source') {
      await ensureSources();
      const source=(await query('SELECT * FROM sources WHERE id=$1',[action.id]))[0];
      if(!source)throw new DomainError('来源不存在',404);
      const config=action.config??source.config;
      if(action.enabled===true||action.config)await validateSource(action.id,config);
      await query('UPDATE sources SET enabled=COALESCE($2,enabled),config=$3,next_run=CASE WHEN $2=true THEN now() ELSE next_run END WHERE id=$1',[action.id,action.enabled??null,config]);
      return Response.json({ok:true},{headers});
    }
    if(action.action==='export')return Response.json({ok:true,id:await createExport()},{headers});
    return Response.json({ok:true,...await executeDomain(action)},{headers});
  } catch(error){return failure(error);}
}
