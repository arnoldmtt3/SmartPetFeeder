'use strict';
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { READ_PATHS,validateRequest } = require('../shared/device-protocol');

function createAgent({ cloudUrl, deviceToken, localToken, ledgerPath = path.join(__dirname, 'data/agent.db'),
  localUrl = 'http://127.0.0.1:3000', fetchImpl = fetch, now = Date.now, bootId = randomUUID() }) {
  const cloud = new URL(cloudUrl);
  if (cloud.protocol !== 'https:' && !(cloud.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(cloud.hostname))) throw new Error('CLOUD_URL debe usar HTTPS (HTTP solo en localhost)');
  const local = new URL(localUrl);
  if (local.protocol !== 'http:' || !['localhost','127.0.0.1','[::1]'].includes(local.hostname)) throw new Error('LOCAL_URL debe apuntar a localhost');
  if (!deviceToken || deviceToken.length < 32 || !localToken || localToken.length < 32) throw new Error('Se requieren DEVICE_TOKEN y AGENT_LOCAL_TOKEN de al menos 32 caracteres');
  if (ledgerPath !== ':memory:') fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const db = new DatabaseSync(ledgerPath);
  db.exec('CREATE TABLE IF NOT EXISTS executed(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL)');
  let telemetry={},closed=false,cameraTask=null,cameraUntil=0,cameraAbort=null,tickTask=null;
  const pendingRequests=new Set();
  // Slow diagnostics and camera uploads must not hold up the command loop.
  const telemetryGroups=[
    {interval:2000,paths:[...READ_PATHS].filter(p=>!['/sequence_status','/schedules','/api/wifi','/api/feed-log','/api/consumption','/api/server-time','/api/last-feed'].includes(p))},
    {interval:5000,paths:['/api/feed-log','/api/consumption','/api/server-time','/api/last-feed']},
    {interval:30000,paths:['/api/wifi']},
  ].map(group=>({...group,lastAt:-Infinity,task:null,revision:0}));
  function refreshTelemetry() {
    if(closed)return;
    for(const group of telemetryGroups) {
      if(group.task||now()-group.lastAt<group.interval)continue;
      const revision=group.revision;
      group.lastAt=now();
      group.task=Promise.all(group.paths.map(async route=>{
        try{return [route,await request(local,route,localToken,'GET',undefined,1500)];}
        catch{return [route,null];}
      })).then(readings=>{
        if(!closed&&revision===group.revision)telemetry={...telemetry,...Object.fromEntries(readings)};
      }).finally(()=>{group.task=null;});
    }
  }
  function invalidateTelemetry(route) {
    for(const group of telemetryGroups) {
      if(group.paths.includes('/api/wifi')&&route!=='/api/wifi/connect')continue;
      group.revision++;group.lastAt=-Infinity;
    }
    refreshTelemetry();
  }
  async function request(base, route, token, method = 'GET', payload, timeout=6000) {
    if(closed)throw new Error('Agente detenido');
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),timeout);
    pendingRequests.add(abort);
    try {
      const response = await fetchImpl(new URL(route, base), { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), redirect: 'error', signal: abort.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {clearTimeout(timer);pendingRequests.delete(abort);}
  }
  async function execute(c, snapshot) {
    if (typeof c.id !== 'string' || !/^[a-f0-9-]{36}$/.test(c.id) || !Number.isFinite(c.expiresAt)) throw new Error('Orden inválida');
    if (now() >= c.expiresAt) return { status: 'expired', result: { message: 'Orden vencida' } };
    if (!snapshot.localReady) return { status: 'failed', result: { message: 'Servidor local no disponible' } };
    if (db.prepare('SELECT id FROM executed WHERE id=?').get(c.id)) return { status: 'failed', result: { message: 'Orden duplicada omitida' } };
    const p = c.payload;
    let route, method = 'POST',body=p;
    if(c.action==='request') {
      const request=validateRequest(p);route=request.path;method=request.method;body=request.body;
      if(['/feed','/dosifier/test','/door/upper','/door/lower'].includes(route)&&snapshot.state?.is_running)return {status:'failed',result:{message:'El alimentador está ocupado'}};
    } else if (['feed','addSchedule'].includes(c.action)) {
      if (!p || !Number.isInteger(p.portions) || p.portions < 1 || p.portions > 200 || typeof p.humidify !== 'boolean') throw new Error('Porción inválida');
      if (c.action === 'feed' && snapshot.state?.is_running) return { status: 'failed', result: { message: 'El alimentador está ocupado' } };
      if (c.action === 'addSchedule' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.time || '')) throw new Error('Hora inválida');
      route = c.action === 'feed' ? '/feed' : '/schedules';
    } else if (c.action === 'deleteSchedule' && /^[A-Za-z0-9_-]{1,80}$/.test(p?.id || '')) {
      route = `/schedules/${p.id}`; method = 'DELETE';
    } else throw new Error('Acción no permitida');
    // Record BEFORE execution: after a crash, never repeat an actuator command.
    db.prepare('INSERT INTO executed VALUES(?,?)').run(c.id, now());
    try {
      const result = await request(local, route, localToken, method, method === 'DELETE' ? undefined : body);
      invalidateTelemetry(route);
      return { status: result.error || result.status === 'rejected' || result.status === 'error' ? 'failed' : 'completed', result };
    } catch {
      return { status: 'failed', result: { message: 'Sin confirmación local. Comprueba el historial antes de repetir.' } };
    }
  }
  async function sendCameraFrames() {
    const abort=new AbortController();cameraAbort=abort;
    pendingRequests.add(abort);
    let latest=null,reader=null,idleAt=now();
    const active=()=>!closed&&!abort.signal.aborted&&now()<cameraUntil&&telemetry['/api/camera']?.enabled===true;
    // A lost viewer, controller or network must release the stream promptly.
    const watchdog=setInterval(()=>{if(!active()||now()-idleAt>4000)abort.abort();},200);
    let uploading=null;
    try {
      // Recheck physical consent immediately before capture; never reopen the camera.
      const camera=await request(local,'/api/camera',localToken,'GET',undefined,1500);
      if(camera.enabled!==true||!active())return;
      const response=await fetchImpl(new URL('/video_feed',local),{headers:{Authorization:`Bearer ${localToken}`},signal:abort.signal,redirect:'error'});
      if(!response.ok||!response.body)return;
      reader=response.body.getReader();
      // One pending frame, one upload. Slow links discard old pictures, never queue them.
      uploading=(async()=>{
        while(active()) {
          if(!latest){await new Promise(r=>setTimeout(r,20));continue;}
          const jpeg=latest;latest=null;const began=now();
          const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(),2500);
          try {
            const result=await fetchImpl(new URL('/api/agent/frame',cloud),{method:'POST',headers:{Authorization:`Bearer ${deviceToken}`,'Content-Type':'image/jpeg'},body:jpeg,redirect:'error',signal:AbortSignal.any([abort.signal,timeout.signal])});
            if(!result.ok){abort.abort();break;}
            // Consume the tiny acknowledgement so connections remain reusable.
            if(result.body)await result.arrayBuffer();
          } catch {abort.abort();break;}
          finally {clearTimeout(timer);}
          await new Promise(r=>setTimeout(r,Math.max(0,200-(now()-began))));
        }
      })();
      let bytes=Buffer.alloc(0);
      while(active()) {
        const chunk=await reader.read();if(chunk.done)break;idleAt=now();
        if(bytes.length+chunk.value.length>1024000)throw new Error('Imagen demasiado grande');
        bytes=Buffer.concat([bytes,Buffer.from(chunk.value)]);
        while(true) {
          const start=bytes.indexOf(Buffer.from([255,216]));
          if(start<0){bytes=bytes.subarray(Math.max(0,bytes.length-1));break;}
          if(start>0)bytes=bytes.subarray(start);
          const end=bytes.indexOf(Buffer.from([255,217]),2);
          if(end<0){if(bytes.length>512000)throw new Error('Imagen demasiado grande');break;}
          if(end+2>512000)throw new Error('Imagen demasiado grande');
          latest=Buffer.from(bytes.subarray(0,end+2));bytes=bytes.subarray(end+2);
        }
      }
    } catch { /* Camera failure must never stop command delivery. */ }
    finally {
      abort.abort();clearInterval(watchdog);latest=null;
      if(reader)await reader.cancel().catch(()=>{});
      if(uploading)await uploading;
      pendingRequests.delete(abort);if(cameraAbort===abort)cameraAbort=null;
    }
  }
  async function runTick() {
    if(closed)return;
    let snapshot = { localReady: false };
    try {
      const [state,schedules] = await Promise.all([
        request(local,'/sequence_status',localToken),
        request(local,'/schedules',localToken),
      ]);
      refreshTelemetry();
      snapshot = { localReady: true,agentVersion:4,state,schedules,telemetry:{...telemetry,'/sequence_status':state,'/schedules':schedules} };
    } catch { /* Keep cloud online even when local controller fails. */ }
    const { command,cameraRequested } = await request(cloud, '/api/agent/poll', deviceToken, 'POST', { bootId, snapshot });
    if (command) {
      if(command.action==='request'&&command.payload?.path==='/api/camera'&&command.payload.body?.enabled===false){cameraUntil=0;cameraAbort?.abort();}
      let result;
      try { result = await execute(command, snapshot); }
      catch (e) { result = { status: 'failed', result: { message: e.message } }; }
      await request(cloud, `/api/agent/result/${command.id}`, deviceToken, 'POST', result);
    }
    cameraUntil=cameraRequested&&snapshot.localReady&&telemetry['/api/camera']?.enabled===true?now()+5000:0;
    if(!cameraUntil)cameraAbort?.abort();
    if(cameraUntil&&!cameraTask) {
      cameraTask=sendCameraFrames().finally(()=>{cameraTask=null;});
    }
    db.prepare('DELETE FROM executed WHERE created_at<?').run(now() - 30 * 86400000);
  }
  function tick() {
    if(closed)return Promise.resolve();
    // Never overlap command execution, even if two callers request a poll.
    if(!tickTask)tickTask=runTick().finally(()=>{tickTask=null;});
    return tickTask;
  }
  return { tick, close: () => {
    if(closed)return;
    closed=true;
    for(const request of pendingRequests)request.abort();
    db.close();
  } };
}
if (require.main === module) {
  const agent = createAgent({ cloudUrl: process.env.CLOUD_URL, deviceToken: process.env.DEVICE_TOKEN,
    localToken: process.env.AGENT_LOCAL_TOKEN, localUrl: process.env.LOCAL_URL,
    ...(process.env.AGENT_DB_PATH ? { ledgerPath: process.env.AGENT_DB_PATH } : {}) });
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  (async () => {
    while (!stopped) {
      try { await agent.tick(); } catch (e) { console.error('Agente sin conexión:', e.message); }
      if (!stopped) await new Promise(resolve => setTimeout(resolve, 750));
    }
    agent.close();
  })().catch(e => { console.error(e.message); process.exitCode = 1; });
}
module.exports = { createAgent };
