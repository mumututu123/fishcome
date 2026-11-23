import { performance } from 'node:perf_hooks';
import { World, CONFIG } from '../www/engine.js';
import assert from 'node:assert/strict';
const start = Date.now(), world = new World(start), cells = Array.from({length:15}, (_,i)=>({x:i,y:i,ch:'o',color:'#8be7df'}));
for(let i=0;i<500;i++) { const actor='actor-'+i; assert(world.apply({id:crypto.randomUUID(),actor,t:start,kind:'fish',cost:15,cells,x:(i%40)*19,y:10+(Math.floor(i/40)%6)*16}).ok); for(let j=0;j<5;j++) assert(world.apply({id:crypto.randomUUID(),actor,t:start,kind:'food',cost:1,x:(i*13+j)%CONFIG.width,y:0,ch:'口',color:'#f8d89b'}).ok); }
assert.equal(world.counts().characters,10000); assert.equal(world.counts().fish,500);
const times=[]; for(let i=1;i<=40;i++) { const at=performance.now(); world.step(start+i*CONFIG.step); times.push(performance.now()-at); }
times.sort((a,b)=>a-b); const json=JSON.stringify(world.serialize());
// A bounded connected overlay, with duplicate suppression, must deliver to every node.
const neighbors=Array.from({length:500},(_,i)=>new Set([1,7,31].flatMap(d=>[(i+d)%500,(i-d+500)%500]))), seen=new Set([0]), queue=[0];let forwards=0;
for(let i=0;i<queue.length;i++)for(const next of neighbors[queue[i]]) { forwards++; if(!seen.has(next)){seen.add(next);queue.push(next);} }
assert.equal(seen.size,500); assert.equal(Math.max(...neighbors.map(s=>s.size)),6);
console.log(JSON.stringify({participants:500,characters:10000,steps:40,step_ms:{median:times[20],p95:times[38],max:times[39]},snapshot_bytes:Buffer.byteLength(json),overlay:{reached:seen.size,degree:6,edge_forwards:forwards},note:'Node simulation and overlay-model test; not 500 real browsers or an intranet capacity certificate'},null,2));
