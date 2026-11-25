import { assetPlatformLabel, normalizeAssetSuffix } from './update.js';

const input = document.getElementById('address'), copy = document.getElementById('copy'), status = document.getElementById('inviteStatus');
const downloadPackage = document.getElementById('downloadPackage'), launchGuide = document.getElementById('launchGuide');
try {
  const invitation = new URLSearchParams(location.search).get('invite');
  const response = await fetch('/invite' + (invitation ? '?invite=' + encodeURIComponent(invitation) : ''), { cache: 'no-store' }), data = await response.json();
  if (!response.ok || typeof data.invite !== 'string' || !data.invite.startsWith('YL1.')) throw new Error();
  const suffix = normalizeAssetSuffix(data.assetSuffix);
  const platformLabel = assetPlatformLabel(suffix);
  const launchEntry = suffix === 'linux-amd64' ? '运行「./fishcome」' : '双击「鱼来.exe」';
  input.value = data.invite; copy.disabled = false;
  downloadPackage.href = '/download.zip?invite=' + encodeURIComponent(data.invite);
  downloadPackage.textContent = `下载启动包 · ${platformLabel}`;
  if (launchGuide) launchGuide.textContent = `下载便携启动包，解压后${launchEntry}。若使用不同系统，请先下载适合自己系统的发布包，再粘贴下方邀请码。每个人从自己的本地启动器进入，身份和记忆留在自己的浏览器里。`;
} catch { status.textContent = '邀请码暂时无法生成，请运行更新后的启动器。'; }
copy.onclick = async () => {
  try { if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(input.value); else { input.select(); if (!document.execCommand('copy')) throw new Error(); } copy.textContent = '邀请码已复制'; }
  catch { input.select(); status.textContent = '请手动复制选中的邀请码。'; }
};
