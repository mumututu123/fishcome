const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { unpackZip, withReleaseFixtures } = require('./release-fixtures.cjs');
const { verifyBrowserPeerUpdate } = require('./hot-update.cjs');

const legacyRevision = '7d6e2916dcec49d37824004592b777eaec55cdb5';

async function main({ root, buildVersion, startLauncher }) {
  const legacyArchive = path.join(root, 'legacy-source.zip');
  const legacySource = path.join(root, 'legacy-source');
  execFileSync('git', ['archive', '--format=zip', '-o', legacyArchive, legacyRevision], {
    cwd: path.resolve(__dirname, '..'), stdio: 'inherit', windowsHide: true
  });
  unpackZip(legacyArchive, legacySource);
  const legacy = buildVersion('0.1.1', 'legacy', legacySource);
  const current = buildVersion('0.2.0', 'current');
  await verifyBrowserPeerUpdate(startLauncher, legacy, current, { legacyCheckpoint: true, allowRuleUpgrade: true });
}

if (process.platform !== 'win32') throw new Error('旧启动器迁移验证需要 Windows');
withReleaseFixtures(main)
  .then(() => console.log('Windows 的旧启动器已从同事更新到 Go 版，原位替换成功，鱼、配额和邀请码均保留。'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
