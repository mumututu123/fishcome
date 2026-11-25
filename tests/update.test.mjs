import test from 'node:test';
import assert from 'node:assert/strict';
import { WORLD_RULES, RULES_VERSION, rulesCompatible } from '../www/rules.js';
import { parseSemver, compareSemver, isNewerVersion, isPrerelease, DEFAULT_ASSET_SUFFIX, normalizeAssetSuffix, assetPlatformLabel, classifyPeerCompatibility, parseGithubReleaseInput, detectUpdateSource, formatUpdateBytes, pickHigherVersionPeers } from '../www/update.js';

test('SemVer 2.0.0 正式版与测试版比较规则正确', () => {
  assert.equal(compareSemver('0.2.0', '0.1.9'), 1);
  assert.equal(compareSemver('0.1.1', '0.1.1'), 0);
  assert.equal(compareSemver('0.2.0', '0.2.0-beta.1'), 1);
  assert.equal(compareSemver('0.2.0-beta.10', '0.2.0-beta.2'), 1);
  assert.equal(compareSemver('0.2.0-rc.1', '0.2.0-beta.99'), 1);
  assert.equal(compareSemver('0.2.0-alpha.1', '0.2.0-alpha'), 1);
  assert.equal(compareSemver('0.2.0-1', '0.2.0-alpha'), -1);
  assert.equal(compareSemver('1.0.0+build.1', '1.0.0+build.2'), 0);
  assert.equal(compareSemver('1.0.0-0a', '1.0.0-1'), 1);
  assert.equal(compareSemver('1.0.0-beta-2', '1.0.0-beta-1'), 1);
  assert.equal(compareSemver('999999999999999999999.0.0', '999999999999999999998.0.0'), 1);
  assert.equal(isNewerVersion('0.2.0-beta.1', '0.1.1'), true);
  assert.equal(isNewerVersion('0.2.0-beta.1', '0.2.0'), false);
  assert.equal(isPrerelease('0.2.0-beta.1'), true);
  assert.equal(isPrerelease('0.2.0'), false);
  assert.equal(parseSemver('0.2'), null);
  assert.equal(parseSemver('01.2.3'), null);
  assert.equal(parseSemver('1.02.3'), null);
  assert.equal(parseSemver('1.2.3-01'), null);
  assert.throws(() => compareSemver('invalid', '0.1.1'));
});

test('联机规则版本单一真相源双向兼容判断覆盖全部场景', () => {
  assert.equal(RULES_VERSION, Object.values(WORLD_RULES).join('.'));
  assert.equal(rulesCompatible({ ...WORLD_RULES }), true);
  assert.equal(rulesCompatible({ ...WORLD_RULES, life: WORLD_RULES.life + 1 }), false);
  assert.equal(rulesCompatible({ ...WORLD_RULES, extraRule: 1 }), false);
  assert.equal(rulesCompatible(null), false);

  assert.equal(classifyPeerCompatibility('0.1.1', { version: '0.1.1', rules: WORLD_RULES }).action, 'connect');
  assert.equal(classifyPeerCompatibility('0.1.1', { version: '0.2.0', rules: WORLD_RULES }).action, 'connect_with_hint');
  assert.equal(classifyPeerCompatibility('0.1.1', { version: '0.2.0', rules: { ...WORLD_RULES, life: 99 } }).action, 'block_update_self');
  assert.equal(classifyPeerCompatibility('0.2.0', { version: '0.1.1', rules: { ...WORLD_RULES, life: 1 } }).action, 'block_update_peer');
  assert.equal(classifyPeerCompatibility('0.2.0', { version: '0.2.0', rules: { ...WORLD_RULES, life: 99 } }).action, 'block_incompatible');
  assert.equal(classifyPeerCompatibility('0.2.0', { version: '0.1.1' }).action, 'connect');
});

test('GitHub Release 链接解析限定官方 HTTPS 域名并校验完整路径与版本一致性', () => {
  const fromTag = parseGithubReleaseInput('https://github.com/acme/fishcome/releases/tag/v0.2.0-beta.1/');
  assert.equal(fromTag.version, '0.2.0-beta.1');
  assert.equal(fromTag.downloadUrl, 'https://github.com/acme/fishcome/releases/download/v0.2.0-beta.1/fishcome-0.2.0-beta.1-windows.zip');
  assert.equal(fromTag.sourceLabel, 'https://github.com/acme/fishcome/releases/tag/v0.2.0-beta.1');

  const fromAsset = parseGithubReleaseInput('https://github.com/acme/fishcome/releases/download/v0.2.0/fishcome-0.2.0-windows.zip');
  assert.equal(fromAsset.version, '0.2.0');
  assert.equal(fromAsset.sourceLabel, 'https://github.com/acme/fishcome/releases/download/v0.2.0/fishcome-0.2.0-windows.zip');

  assert.throws(() => parseGithubReleaseInput('http://github.com/acme/fishcome/releases/tag/v0.2.0'));
  assert.throws(() => parseGithubReleaseInput('https://evil.example/acme/fishcome/releases/tag/v0.2.0'));
  assert.throws(() => parseGithubReleaseInput('https://user:pass@github.com/acme/fishcome/releases/tag/v0.2.0'));
  assert.throws(() => parseGithubReleaseInput('https://github.com:8443/acme/fishcome/releases/tag/v0.2.0'));
  assert.throws(() => parseGithubReleaseInput('https://github.com/acme/fishcome/releases/download/v0.2.0/fishcome-0.3.0-windows.zip'));
  assert.throws(() => parseGithubReleaseInput('https://github.com/acme/fishcome/releases/latest'));
});

test('更新来源自动识别、字节进度格式化与更高版本同事筛选准确', () => {
  const gh = detectUpdateSource('  https://github.com/acme/fishcome/releases/tag/v0.2.0  ');
  assert.equal(gh.kind, 'github');
  assert.equal(gh.parsed.version, '0.2.0');

  const peer = detectUpdateSource(' YL1.testcode ');
  assert.equal(peer.kind, 'peer');
  assert.equal(peer.input, 'YL1.testcode');

  assert.throws(() => detectUpdateSource('   '));
  assert.throws(() => detectUpdateSource('https://evil.example/a/b/releases/tag/v0.2.0'));

  assert.equal(formatUpdateBytes(512, 1024), '512 B / 1 KB（50%）');
  assert.equal(formatUpdateBytes(2 * 1024 * 1024, 4 * 1024 * 1024), '2.0 MB / 4.0 MB（50%）');
  assert.equal(formatUpdateBytes(1536, -1), '已下载 2 KB');
  assert.equal(formatUpdateBytes(0, -1), '');

  const picked = pickHigherVersionPeers('0.1.1', [
    { invite: 'YL1.old', nick: '旧版', version: '0.1.0' },
    { invite: 'YL1.same', nick: '同版', version: '0.1.1' },
    { invite: 'YL1.new1', nick: '同事甲', version: '0.2.0-beta.1' },
    { invite: 'YL1.new2', nick: '同事乙', version: '0.2.0' },
    { invite: 'YL1.new1', nick: '同事甲', version: '0.2.1' }
  ]);
  assert.deepEqual(picked.map(p => [p.invite, p.version, p.prerelease]), [
    ['YL1.new1', '0.2.1', false],
    ['YL1.new2', '0.2.0', false]
  ]);
});

test('跨平台 assetSuffix 兼容旧启动器、按同平台挑选更新候选且不阻止异平台联机', () => {
  assert.equal(DEFAULT_ASSET_SUFFIX, 'windows');
  assert.equal(normalizeAssetSuffix(undefined), 'windows');
  assert.equal(normalizeAssetSuffix(''), 'windows');
  assert.equal(normalizeAssetSuffix('  '), 'windows');
  assert.equal(normalizeAssetSuffix('windows'), 'windows');
  assert.equal(normalizeAssetSuffix('linux-amd64'), 'linux-amd64');
  assert.equal(assetPlatformLabel(undefined), 'Windows');
  assert.equal(assetPlatformLabel('linux-amd64'), 'Linux x64');

  const winToLinuxNewer = classifyPeerCompatibility('0.1.1', { version: '0.2.0', rules: WORLD_RULES, assetSuffix: 'linux-amd64' }, 'windows');
  assert.equal(winToLinuxNewer.compatible, true);
  assert.equal(winToLinuxNewer.action, 'connect_with_hint');
  assert.equal(winToLinuxNewer.samePlatform, false);
  assert.equal(winToLinuxNewer.canPeerUpdate, false);

  const linuxToLegacyWin = classifyPeerCompatibility('0.2.0', { version: '0.2.0', rules: WORLD_RULES }, 'linux-amd64');
  assert.equal(linuxToLegacyWin.compatible, true);
  assert.equal(linuxToLegacyWin.action, 'connect');
  assert.equal(linuxToLegacyWin.peerAssetSuffix, 'windows');
  assert.equal(linuxToLegacyWin.samePlatform, false);
  assert.equal(linuxToLegacyWin.canPeerUpdate, false);

  const blockedCross = classifyPeerCompatibility('0.1.1', { version: '0.2.0', rules: { ...WORLD_RULES, life: 99 }, assetSuffix: 'linux-amd64' }, 'windows');
  assert.equal(blockedCross.compatible, false);
  assert.equal(blockedCross.action, 'block_update_self');
  assert.equal(blockedCross.samePlatform, false);
  assert.equal(blockedCross.canPeerUpdate, false);

  const legacyWinToGoWin = classifyPeerCompatibility('0.1.1', { version: '0.2.0', rules: WORLD_RULES, assetSuffix: 'windows' }, undefined);
  assert.equal(legacyWinToGoWin.samePlatform, true);
  assert.equal(legacyWinToGoWin.canPeerUpdate, true);

  const linuxToLinux = classifyPeerCompatibility('0.1.1', { version: '0.2.0', rules: WORLD_RULES, assetSuffix: 'linux-amd64' }, 'linux-amd64');
  assert.equal(linuxToLinux.samePlatform, true);
  assert.equal(linuxToLinux.canPeerUpdate, true);

  const peers = [
    { invite: 'YL1.win-legacy', nick: '旧版Win', version: '0.2.0' },
    { invite: 'YL1.win-go', nick: '新版Win', version: '0.2.1', assetSuffix: 'windows' },
    { invite: 'YL1.linux', nick: 'Linux同事', version: '0.3.0', assetSuffix: 'linux-amd64' }
  ];
  assert.deepEqual(
    pickHigherVersionPeers('0.1.1', peers, 'windows').map(p => [p.invite, p.assetSuffix]),
    [['YL1.win-go', 'windows'], ['YL1.win-legacy', 'windows']]
  );
  assert.deepEqual(
    pickHigherVersionPeers('0.1.1', peers, 'linux-amd64').map(p => [p.invite, p.assetSuffix]),
    [['YL1.linux', 'linux-amd64']]
  );
});

test('GitHub Release 链接解析按平台生成资产名、支持本机测试地址并对异平台直链给出明确提示', () => {
  const linuxTag = parseGithubReleaseInput('https://github.com/acme/fishcome/releases/tag/v0.2.0-beta.1/', 'linux-amd64');
  assert.equal(linuxTag.version, '0.2.0-beta.1');
  assert.equal(linuxTag.assetSuffix, 'linux-amd64');
  assert.equal(linuxTag.downloadUrl, 'https://github.com/acme/fishcome/releases/download/v0.2.0-beta.1/fishcome-0.2.0-beta.1-linux-amd64.zip');
  assert.equal(linuxTag.sourceLabel, 'https://github.com/acme/fishcome/releases/tag/v0.2.0-beta.1');

  const linuxAsset = parseGithubReleaseInput('https://github.com/acme/fishcome/releases/download/v0.2.0-beta.1/fishcome-0.2.0-beta.1-linux-amd64.zip', 'linux-amd64');
  assert.equal(linuxAsset.version, '0.2.0-beta.1');
  assert.equal(linuxAsset.assetSuffix, 'linux-amd64');
  assert.equal(linuxAsset.downloadUrl, 'https://github.com/acme/fishcome/releases/download/v0.2.0-beta.1/fishcome-0.2.0-beta.1-linux-amd64.zip');

  const localLinuxTag = parseGithubReleaseInput('http://127.0.0.1:39999/acme/fishcome/releases/tag/v0.2.1-beta.1', 'linux-amd64');
  assert.equal(localLinuxTag.downloadUrl, 'http://127.0.0.1:39999/acme/fishcome/releases/download/v0.2.1-beta.1/fishcome-0.2.1-beta.1-linux-amd64.zip');

  const localLinuxAsset = detectUpdateSource('http://127.0.0.1:39999/acme/fishcome/releases/download/v0.2.1-beta.1/fishcome-0.2.1-beta.1-linux-amd64.zip', 'linux-amd64');
  assert.equal(localLinuxAsset.kind, 'github');
  assert.equal(localLinuxAsset.parsed.assetSuffix, 'linux-amd64');

  assert.throws(
    () => parseGithubReleaseInput('https://github.com/acme/fishcome/releases/download/v0.2.0/fishcome-0.2.0-linux-amd64.zip', 'windows'),
    /Linux x64.*Windows/
  );
  assert.throws(
    () => parseGithubReleaseInput('https://github.com/acme/fishcome/releases/download/v0.2.0/fishcome-0.2.0-windows.zip', 'linux-amd64'),
    /Windows.*Linux x64/
  );
  assert.throws(
    () => detectUpdateSource('http://127.0.0.1:39999/acme/fishcome/releases/download/v0.2.0/fishcome-0.2.0-windows.zip', 'linux-amd64'),
    /Windows.*Linux x64/
  );
  assert.throws(
    () => parseGithubReleaseInput('https://github.com/acme/fishcome/releases/download/v0.2.0/fishcome-0.3.0-linux-amd64.zip', 'linux-amd64'),
    /版本不一致/
  );
});
