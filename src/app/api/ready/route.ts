import { query } from '../../../server/db';
export const dynamic='force-dynamic';
export async function GET(){
  try{await query('SELECT id FROM events LIMIT 1');return Response.json({status:'ready'},{headers:{'Cache-Control':'no-store'}});}
  catch{return Response.json({status:'unavailable'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
