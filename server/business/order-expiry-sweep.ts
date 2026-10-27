export function startOrderExpirySweep(run:()=>Promise<unknown>,intervalMs:number):()=>void{
  const timer=setInterval(()=>{void run().catch(()=>undefined)},intervalMs);
  timer.unref?.();
  return ()=>clearInterval(timer);
}
