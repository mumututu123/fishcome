const assert = require('node:assert/strict');
const base = process.env.TIDE_UI_URL || 'http://127.0.0.1:39241';
async function main() {
  const response = await fetch(base + '/', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  assert(response.ok, `入口 HTTP ${response.status}`);
  const html = await response.text();
  assert(html.includes('id="myFish"'), '当前启动器实际返回的页面缺少「我的鱼」按钮');
  assert(html.includes('id="myFishDialog"'), '当前启动器缺少「我的鱼」列表');
  assert(html.includes('id="fishGenderPicker"') && html.includes('value="male"') && html.includes('value="female"'), '当前启动器缺少公母性别选择');
  const script = await fetch(base + '/app.js', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  assert(script.ok, '实际入口 app.js 无法加载'); const app = await script.text();
  assert(app.includes("$('myFish').onclick"), '实际入口缺少「我的鱼」事件绑定');
  assert(app.includes("e.key.toLowerCase() === 'p'"), '实际入口缺少 P 键绑定');
  assert(app.includes('`${identity.nick} 的鱼`') && app.includes('renderFishGender(entry.gender, fish)'), '实际入口缺少完整昵称或性别展示');
  const stats = await fetch(base + '/fish-status.js', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  assert(stats.ok, '实际入口缺少鱼况统计模块');
  const plants = await fetch(base + '/seaweed.js', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  assert(plants.ok && (await plants.text()).includes('updateSeaweed'), '实际入口缺少海草生态模块');
  assert(html.includes('海底会长海草'), '实际入口缺少海草玩法说明');
  const reproduction = await fetch(base + '/breeding.js', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  assert(reproduction.ok && (await reproduction.text()).includes('finishBreeding'), '实际入口缺少繁殖模块');
  assert(html.includes('id="fishBreeding"') && html.includes('结伴繁殖'), '实际入口缺少繁殖状态和玩法说明');
  console.log('实际启动器入口：我的鱼、性别、海草与繁殖系统均已发布');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
