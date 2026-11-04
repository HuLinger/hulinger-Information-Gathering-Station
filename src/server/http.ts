import { ZodError } from 'zod';
export const privateHeaders={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
export function failure(error:unknown) {
  if(error instanceof ZodError)return Response.json({error:'输入格式不正确，请检查字段。',code:'INVALID_INPUT'},{status:400,headers:privateHeaders});
  if(error instanceof Error&&'status' in error&&typeof error.status==='number')return Response.json({error:error.message,code:'code' in error?error.code:'REQUEST_FAILED'},{status:error.status,headers:privateHeaders});
  console.error(JSON.stringify({event:'request_failed',errorType:error instanceof Error?error.name:'unknown'}));
  return Response.json({error:'操作未完成，请稍后重试。',code:'INTERNAL_ERROR'},{status:500,headers:privateHeaders});
}
