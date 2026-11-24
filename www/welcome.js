const input = document.getElementById('address'), copy = document.getElementById('copy'), status = document.getElementById('inviteStatus');
try {
  const invitation = new URLSearchParams(location.search).get('invite');
  const response = await fetch('/invite' + (invitation ? '?invite=' + encodeURIComponent(invitation) : ''), { cache: 'no-store' }), data = await response.json();
  if (!response.ok || typeof data.invite !== 'string' || !data.invite.startsWith('YL1.')) throw new Error();
  input.value = data.invite; copy.disabled = false; document.getElementById('downloadPackage').href = '/download.zip?invite=' + encodeURIComponent(data.invite);
} catch { status.textContent = '邀请码暂时无法生成，请运行更新后的启动器。'; }
copy.onclick = async () => {
  try { if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(input.value); else { input.select(); if (!document.execCommand('copy')) throw new Error(); } copy.textContent = '邀请码已复制'; }
  catch { input.select(); status.textContent = '请手动复制选中的邀请码。'; }
};
