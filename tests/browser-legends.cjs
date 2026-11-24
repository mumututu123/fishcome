const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const project = path.resolve(__dirname, '..'), output = path.join(project, 'test-output'), clients = new Map(), errors = [];
let origin, browser;
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost'), route = url.pathname;
  const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
  if (route === '/local/meta') return json({ token: 'test', url: origin });
  if (route === '/local/events') {
    const client = clients.get(url.searchParams.get('node')); if (!client) { response.writeHead(404); return response.end(); }
    client.response = response; client.active = true; response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': ready\n\n'); response.on('close', () => client.active = false); return;
  }
  if (route.startsWith('/local/')) {
    let raw = ''; for await (const chunk of request) raw += chunk; const body = raw ? JSON.parse(raw) : {};
    if (route === '/local/register') clients.set(body.node, { id: body.node, nick: body.nick, active: false });
    if (route === '/local/unregister' && clients.has(body.node)) clients.get(body.node).active = false;
    if (route === '/local/probe') return json({ ok: true, clients: [...clients.values()].filter(c => c.active).map(c => ({ id: c.id, nick: c.nick, peers: 0, url: origin })), hints: [] });
    if (route === '/local/relay') { const target = clients.get(body.signal.to); if (!target?.active) return json({ ok: false }); target.response.write(`data: ${JSON.stringify({ ...body.signal, fromUrl: origin })}\n\n`); }
    return json({ ok: true, clients: [], hints: [] });
  }
  if (route === '/__preview') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(fs.readFileSync(path.join(project, 'test-output', 'legendary-preview.html'))); return; }
  const file = path.join(project, 'www', route === '/' ? 'index.html' : route.slice(1));
  if (!file.startsWith(path.join(project, 'www') + path.sep) || !fs.existsSync(file)) { response.writeHead(404); return response.end(); }
  response.setHeader('Content-Type', { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream'); response.end(fs.readFileSync(file));
});
async function open(context) { const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(origin); await page.waitForFunction(() => window.tide); return page; }
async function main() {
  fs.mkdirSync(output, { recursive: true }); await new Promise(r => server.listen(0, '127.0.0.1', r)); origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const start = Math.floor(Date.now() / 600000) * 600000, contexts = [];
  for (const kind of ['cthulhu','godzilla','ship']) {
    const fixed = start + (kind==='ship'?61000:kind==='godzilla'?29000:22000), context = await browser.newContext({ viewport: { width: 1440,height:900 } }); contexts.push(context);
    await context.addInitScript(fixed => { Date.now=()=>fixed; },fixed);
    const setup=await context.newPage();await setup.goto(origin+'/welcome.html');
    const fixture=await setup.evaluate(async({kind,fixed,start})=>{
      const {World}=await import('./engine.js'),{newIdentity,set,signer}=await import('./storage.js'),{Network}=await import('./network.js');
      const {legendSchedule,legendGeometry,ghostRoll}=await import('./legends.js');
      const me=await newIdentity('异象观察员');me.registration.joined=true;const born=start-7200000,slot=start/600000;let seed,s;
      do{seed=crypto.randomUUID();s=legendSchedule({[seed]:born},seed,slot);}while(s?.kind!==kind||kind==='ship'&&!ghostRoll(seed,slot,1));
      const w=new World(born,seed,{populate:false,ambient:false}),e={seed,slot,at:start,arms:{},minute:0,drops:[]};w.data.legends.events[s.id]=e;
      const n=new Network(me,{},()=>{},()=>{});n.sign=await signer(me);
      const cell=(x,y,ch='o')=>({x,y,ch,color:'#88aacc'});
      async function fish(x,y,cells){const op={id:crypto.randomUUID(),actor:me.actor,nick:me.nick,roots:w.roots,t:born,kind:'fish',name:'异鱼',x,y,cells,cost:cells.length,gender:'male'},proof=await n.makeEnvelope('op',op),result=w.apply({...op,proof});if(!result.ok)throw Error(result.error);return op.id;}
      let captive,survivor,doomed,eater;
      if(kind==='cthulhu'){const p=legendGeometry(w.data,e,fixed-300).find(c=>c.role==='arm'&&c.arm===0&&(c.x-s.x+1500)%1000-500<-6);captive=await fish(p.x,p.y,[cell(0,0),cell(1,0)]);}
      if(kind==='godzilla'){const beam=legendGeometry(w.data,e,fixed-300).filter(c=>c.role==='beam'),p=beam[6],d=beam[12];survivor=await fish(p.x,p.y,[cell(0,0),cell(0,1,'鱼'),cell(0,2,'鱼'),cell(0,3,'鱼'),cell(0,4,'鱼'),cell(0,5,'鱼')]);doomed=await fish(d.x,d.y,[cell(0,0),cell(0,1)]);}
      const effectTime=kind==='ship'?start+60000:fixed;w.data.legends.at=w.data.tick=effectTime-500;w.resolveLegends(effectTime);w.data.tick=effectTime;
      if(kind==='ship'){const food=Object.values(w.data.chars).find(c=>c.ghost);if(!food)throw Error('没有船蛆');eater=await fish((food.x+999)%1000,5,[cell(0,0),cell(1,0)]);food.y=4;w.step(effectTime+500);}
      w.data.tick=w.data.legends.at=w.data.life.at=fixed;me.lifeSeenAt=fixed;await set('identity',me);await set('known',[]);await set('checkpoint',{world:w.serialize(),lastOnlineAt:fixed});
      return {event:s.id,captive,survivor,doomed,eater,balance:w.wallet(me.actor),ends:s.ends};
    },{kind,fixed,start});await setup.close();let page=await open(context);
    await page.locator('#ambientPeek').waitFor({state:'visible'});await page.locator('#ambientPeek').click();assert(await page.locator('#eventDetails').isVisible());await page.locator('#closeInspector').click();
    await page.screenshot({path:path.join(output,`legend-${kind}-desktop.png`)});
    await page.locator('#scene3dToggle').click(); await page.waitForFunction(()=>document.getElementById('scene3dToggle').getAttribute('aria-pressed')==='true');
    const relief = await page.evaluate(async()=>{
      const {World}=await import('./engine.js'),{Renderer}=await import('./renderer.js'),{Scene3D}=await import('./scene-3d.js');
      const w=new World(Date.now(),undefined,{populate:false});w.data=tide.world.data;
      const r=new Renderer(document.createElement('canvas'));r.camera=tide.view.camera;r.scene3d=new Scene3D();const kinds=[],original=r.scene3d.glyph;
      r.scene3d.glyph=function(...args){kinds.push(args[8]);return original.apply(this,args);};r.draw(w);return kinds;
    });assert(relief.includes('legend'), '立体模式没有绘制彩蛋角色');if(kind==='godzilla')assert(relief.includes('breath'),'立体模式没有绘制原子吐息');
    await page.screenshot({path:path.join(output,`legend-${kind}-3d-desktop.png`)});
    if(kind==='cthulhu'){assert(await page.evaluate(id=>Object.values(tide.world.data.legends.events).some(e=>Object.values(e.arms).some(c=>c.fish===id)),fixture.captive));}
    if(kind==='godzilla'){assert(await page.evaluate(id=>!!tide.world.data.fishes[id],fixture.survivor));assert(await page.evaluate(id=>!tide.world.data.fishes[id],fixture.doomed));assert(await page.evaluate(()=>Object.values(tide.world.data.life.stories).some(r=>r.kind==='atomicSurvivor')));}
    if(kind==='ship'){assert(await page.evaluate(()=>Object.values(tide.world.data.life.stories).some(r=>r.kind==='shipMeal')));assert(await page.evaluate(id=>Object.values(tide.world.data.chars).some(c=>c.entity===id&&c.ch==='蛆'),fixture.eater));}
    await page.setViewportSize({width:390,height:844});await page.locator('#ambientPeek').click();await page.screenshot({path:path.join(output,`legend-${kind}-mobile.png`)});const box=await page.locator('#inspector').boundingBox();assert(box.x>=0&&box.x+box.width<=390);await page.locator('#closeInspector').click();
    const peerContext=await browser.newContext();contexts.push(peerContext);await peerContext.addInitScript(fixed=>{Date.now=()=>fixed;},fixed);
    const peerSetup=await peerContext.newPage();await peerSetup.goto(origin+'/welcome.html');await peerSetup.evaluate(async()=>{const{newIdentity,set}=await import('./storage.js');const me=await newIdentity('异象同伴');me.registration.joined=true;await set('identity',me);});await peerSetup.close();
    const peer=await open(peerContext);await peer.locator('#connect').click();await peer.locator('#peerUrl').fill(origin);await peer.locator('#connectionForm .primary').click();await peer.waitForFunction(id=>!!tide.world.data.legends.events[id],fixture.event);
    assert.deepEqual(await peer.evaluate(()=>tide.world.data.legends.burns),await page.evaluate(()=>tide.world.data.legends.burns));
    assert.deepEqual(await peer.evaluate(id=>tide.world.data.legends.events[id],fixture.event),await page.evaluate(id=>tide.world.data.legends.events[id],fixture.event));
    await page.close();page=await open(context);assert.equal(await page.evaluate(()=>tide.balance()),fixture.balance);
    if(kind==='cthulhu'){await peer.close();await page.evaluate(end=>{Date.now=()=>end+1000;},fixture.ends);await page.waitForFunction(id=>!tide.world.data.fishes[id],fixture.captive);}
    await context.close();await peerContext.close();
  }
  const preview=await browser.newPage({viewport:{width:1100,height:800}});preview.on('pageerror',e=>errors.push(e.message));await preview.goto(origin+'/__preview');const frame=preview.frameLocator('iframe');await frame.locator('canvas').waitFor();
  for(const[kind,t,caption]of[['cthulhu',6,'触须缠住鱼'],['godzilla',8.8,'原子吐息'],['ship',7,'蛆字鱼食下沉']]){await frame.locator(`[data-kind="${kind}"]`).click();await frame.locator('[data-action="seek"]').evaluate((el,t)=>{el.value=t;el.dispatchEvent(new Event('input',{bubbles:true}));},t);await preview.screenshot({path:path.join(output,`model-${kind}-preview.png`)});assert.equal(await frame.locator('[data-label="phase"]').textContent(),caption);}
  await frame.locator('[data-action="play"]').click();await frame.locator('[data-action="play"]').filter({hasText:'暂停'}).waitFor();await frame.locator('[data-action="play"]').click();
  await preview.setViewportSize({width:360,height:800});const previewFrame=preview.frames().find(f=>f.parentFrame());await previewFrame.waitForFunction(()=>{const c=document.querySelector('canvas');return Math.abs(c.width/Math.min(2,devicePixelRatio||1)-c.getBoundingClientRect().width)<2;});await preview.screenshot({path:path.join(output,'model-preview-mobile.png')});
  assert.equal(errors.length,0,errors.join('\n'));fs.writeFileSync(path.join(output,'legends-browser-results.json'),JSON.stringify({passed:true,checks:['三种鱼元形体与动作','平面及立体彩蛋与吐息绘制','真实触须捕获及离线到期','真实吐息幸存与死亡','船蛆进食故事','WebRTC来源、捕获与烧毁同步','刷新状态及余额保持','桌面与手机布局','交互动作预览'],errors},null,2));console.log('Legendary browser checks passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.closeAllConnections();server.close();});
