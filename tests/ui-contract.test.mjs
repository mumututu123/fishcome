import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('发布页面包含app.js使用的所有固定元素，世界与连接状态更新不能访问空节点', () => {
  const html = readFileSync(new URL('../www/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../www/app.js', import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
  const required = [...new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]))];
  assert.deepEqual(required.filter(id => !ids.has(id)), []);
  assert(ids.has('worldLabel') && ids.has('networkStatus'));
});

test('拼豆画板的固定控件存在且页面元素标识不重复', () => {
  const html = readFileSync(new URL('../www/index.html', import.meta.url), 'utf8');
  const creator = readFileSync(new URL('../www/creator.js', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  const required = [...new Set([...creator.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]))];
  assert.deepEqual(required.filter(id => !ids.includes(id)), []);
});
