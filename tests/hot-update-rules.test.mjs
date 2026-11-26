import test from 'node:test';
import assert from 'node:assert/strict';
import { assertUpdateRules } from './hot-update.cjs';
import { WORLD_RULES, RULES_VERSION } from '../www/rules.js';

const legacy = { rulesVersion: '1.4.1.1.1.1', rules: { genesis: 1, life: 4, legends: 1, feeding: 1, ecology: 1, archives: 1 } };
const current = { rulesVersion: RULES_VERSION, rules: WORLD_RULES };

test('旧启动器迁移允许升级前规则不同，但完成升级必须与来源规则完全一致', () => {
  assert.notDeepEqual(legacy.rules, current.rules);
  assert.doesNotThrow(() => assertUpdateRules(legacy, current, { allowRuleUpgrade: true }));
  assert.throws(() => assertUpdateRules(legacy, current), /联机规则版本/);
  assert.doesNotThrow(() => assertUpdateRules(structuredClone(current), current));
});

test('普通热更新保留升级前兼容校验，同版本字符串不能掩盖完整规则差异', () => {
  assert.throws(() => assertUpdateRules(legacy, current), /联机规则版本/);
  assert.throws(() => assertUpdateRules({ ...current, rules: legacy.rules }, current), /完整联机规则/);
});

test('允许旧规则迁移仍要求两端提供真实规则元数据', () => {
  assert.throws(() => assertUpdateRules({ rulesVersion: legacy.rulesVersion }, current, { allowRuleUpgrade: true }), /当前启动器/);
  assert.throws(() => assertUpdateRules(legacy, { rules: current.rules }, { allowRuleUpgrade: true }), /来源启动器/);
});
