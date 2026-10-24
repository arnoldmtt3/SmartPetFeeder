'use strict';
// Only a software demo. This file NEVER imports GPIO or moves hardware.
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { authorizeLocalAgent } = require('./local-auth');
const token = process.env.AGENT_LOCAL_TOKEN;
if (!token || token.length < 32) throw new Error('Configura AGENT_LOCAL_TOKEN (32 caracteres o más)');
const schedules = [];
let running = false;
const server = http.createServer(async (req,res) => {
  req.path = new URL(req.url,'http://localhost').pathname;
  res.setHeader('Content-Type','application/json');
  const reply = (code,value) => {res.writeHead(code);res.end(JSON.stringify(value));};
  if (!authorizeLocalAgent(req,token)) return reply(401,{error:'No autorizado'});
  let raw='';
  for await (const part of req) {raw+=part;if(raw.length>8192)return reply(413,{error:'Demasiado grande'});}
  let p;try {p=JSON.parse(raw||'{}');}catch{return reply(400,{error:'JSON inválido'});}
  if (req.method==='GET' && req.path==='/sequence_status') return reply(200,{is_running:running,success:!running,step_name:running?'SIMULACIÓN (sin hardware)':''});
  if (req.method==='GET' && req.path==='/schedules') return reply(200,schedules);
  if (req.method==='POST' && req.path==='/feed') {
    if(running)return reply(409,{status:'error',message:'Simulador ocupado'});
    running=true;setTimeout(()=>{running=false;},5000).unref();return reply(200,{status:'started',simulation:true});
  }
  if (req.method==='POST' && req.path==='/schedules') {
    if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(p.time||''))return reply(400,{status:'error'});
    const [hour,minute]=p.time.split(':').map(Number);
    const s={id:randomUUID(),hour,minute,portions:p.portions,humidify:p.humidify};schedules.push(s);return reply(200,s);
  }
  if(req.method==='DELETE'){const i=schedules.findIndex(s=>s.id===req.path.split('/').pop());if(i>=0)schedules.splice(i,1);return reply(200,{status:'ok'});}
  reply(404,{error:'No encontrado'});
});
server.listen(Number(process.env.SIMULATOR_PORT||3000),'127.0.0.1',()=>console.log('Controlador SIMULADO iniciado; no hay actuadores. Los horarios solo se guardan en memoria.'));
