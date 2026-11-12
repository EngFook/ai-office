#!/usr/bin/env node
// Compatibility entry only; never starts an office worker or proxies API writes.
import { createServer } from 'node:http';
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--port'||args[2]!=='--target'||!/^\d{1,5}$/.test(args[1])) throw Error('Use --port <port> --target <HTTP loopback office URL>');
const port=Number(args[1]),target=new URL(args[3]);
if(port<1024||port>65535||target.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||target.username||target.password||target.pathname!=='/'||target.search||target.hash||Number(target.port)===port) throw Error('Invalid local office redirect');
const server=createServer((req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  let host;try{host=new URL('http://'+req.headers.host);}catch{res.writeHead(400);res.end();return;}
  if(!['127.0.0.1','localhost','[::1]'].includes(host.hostname)||Number(host.port)!==port||host.username||host.password||host.pathname!=='/'||host.search||host.hash){res.writeHead(403);res.end();return;}
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD'});res.end();return;}
  // Preserve old bookmarks without accepting absolute/protocol-relative URLs
  // or backslashes that URL parsing could reinterpret as another authority.
  let destination,decodedPath;
  try{
    if(typeof req.url!=='string'||!req.url.startsWith('/')||req.url.startsWith('//')||/[\\\x00-\x20\x7f#]/.test(req.url))throw Error('Unsafe request target');
    destination=new URL(req.url,target);
    if(destination.origin!==target.origin||destination.username||destination.password)throw Error('Unexpected destination');
    decodedPath=decodeURIComponent(destination.pathname);
  }catch{res.writeHead(400);res.end();return;}
  if(decodedPath==='/api'||decodedPath.startsWith('/api/')){res.writeHead(404);res.end();return;}
  res.writeHead(302,{Location:destination.href});res.end();
});
server.on('error',()=>{console.error('Office compatibility entry could not start; no existing process was changed.');process.exitCode=1;});
server.listen(port,'127.0.0.1');
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.close());
