export async function register() {
  if(process.env.NEXT_RUNTIME==='nodejs'&&process.env.NEXT_PHASE!=='phase-production-build') {
    const { authConfiguration }=await import('./server/auth');
    authConfiguration();
    const { getDrive }=await import('./server/drive/runtime');
    await getDrive().checkStorage();
  }
}
