'use strict';
// The same allowlist is enforced by cloud, agent and loopback controller.
const READ_PATHS = new Set(['/api/camera','/sequence_status','/schedules','/api/feed-log','/api/consumption',
  '/api/last-feed','/api/server-time','/door/upper','/door/lower','/humidify','/api/presence',
  '/api/presence/feed-only','/api/presence/auto-feed','/api/presence/clean','/api/wifi']);
const int = (v,min,max) => Number.isInteger(v) && v>=min && v<=max;
function validateRequest(p) {
  const invalid = message => { throw Object.assign(new Error(message), { status:400 }); };
  if (!p || typeof p.path !== 'string' || !['GET','POST','DELETE'].includes(p.method)) return invalid('Solicitud de dispositivo inválida');
  const b = p.body ?? {};
  if (typeof b !== 'object' || Array.isArray(b)) return invalid('Datos inválidos');
  let body;
  if (p.method === 'GET' && READ_PATHS.has(p.path)) return { method:p.method,path:p.path };
  if (p.method === 'DELETE' && /^\/schedules\/[A-Za-z0-9_-]{1,80}$/.test(p.path)) return { method:p.method,path:p.path };
  if (p.method !== 'POST') return invalid('Ruta no permitida');
  switch(p.path) {
    case '/feed': case '/schedules': case '/api/last-feed':
      if(!int(b.portions,1,200)||typeof b.humidify!=='boolean')return invalid('Porción inválida (1–200 gramos)');
      body={portions:b.portions,humidify:b.humidify};
      if(p.path==='/schedules'){if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time||''))return invalid('Hora inválida');body.time=b.time;}break;
    case '/door/upper': case '/door/lower':
      if(!['open','close'].includes(b.action))return invalid('Acción de compuerta inválida');body={action:b.action};break;
    case '/dosifier/test':
      if(!int(b.grams,1,200))return invalid('Gramos inválidos');body={grams:b.grams};break;
    case '/api/camera':
      if(typeof b.enabled!=='boolean')return invalid('Estado de cámara inválido');body={enabled:b.enabled};break;
    case '/humidify':
      if(typeof b.on!=='boolean')return invalid('Estado inválido');body={on:b.on};break;
    case '/api/consumption/goal':
      if(!int(b.grams,0,1000))return invalid('Meta inválida');body={grams:b.grams};break;
    case '/api/presence/start': case '/api/presence/stop': body={};break;
    case '/api/presence/threshold':
      if(!int(b.seconds,1,120))return invalid('Umbral inválido');body={seconds:b.seconds};break;
    case '/api/presence/feed-only':
      if(typeof b.enabled!=='boolean')return invalid('Estado inválido');body={enabled:b.enabled};break;
    case '/api/presence/auto-feed': case '/api/presence/clean': {
      const key=p.path.endsWith('clean')?'delay_min':'cooldown_min';
      if(typeof b.enabled!=='boolean'||!int(b[key],key==='delay_min'?0:1,120))return invalid('Configuración inválida');
      body={enabled:b.enabled,[key]:b[key]};break;
    }
    case '/api/wifi/connect':
      if(typeof b.ssid!=='string'||!b.ssid||Buffer.byteLength(b.ssid)>32||/[\x00-\x1f]/.test(b.ssid))return invalid('SSID inválido');
      if(b.password!==undefined&&(typeof b.password!=='string'||b.password.length>128))return invalid('Contraseña Wi-Fi inválida');
      body={ssid:b.ssid,...(b.password?{password:b.password}:{})};break;
    default: return invalid(p.path.startsWith('/faja/')?'La faja del controlador original aún no implementa hardware real':'Ruta no permitida');
  }
  return {method:p.method,path:p.path,body};
}
function allowedPath(method,path) {
  if(method==='GET')return READ_PATHS.has(path)||path==='/video_feed';
  if(method==='DELETE')return /^\/schedules\/[A-Za-z0-9_-]{1,80}$/.test(path);
  return method==='POST'&&['/feed','/schedules','/api/last-feed','/door/upper','/door/lower','/dosifier/test','/humidify',
    '/api/camera','/api/consumption/goal','/api/presence/start','/api/presence/stop','/api/presence/threshold','/api/presence/feed-only',
    '/api/presence/auto-feed','/api/presence/clean','/api/wifi/connect'].includes(path);
}
module.exports={READ_PATHS,validateRequest,allowedPath};
