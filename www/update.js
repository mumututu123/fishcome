import { rulesCompatible } from './rules.js';

// SemVer 2.0.0: no leading zeros on numeric identifiers; optional prerelease and ignored build metadata.
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function compareNumericStrings(x, y) {
  if (x.length !== y.length) return x.length > y.length ? 1 : -1;
  if (x === y) return 0;
  return x > y ? 1 : -1;
}

export function parseSemver(version) {
  if (typeof version !== 'string') return null;
  const trimmed = version.trim();
  const match = SEMVER_RE.exec(trimmed);
  if (!match) return null;
  return {
    raw: trimmed,
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease: match[4] ? match[4].split('.') : [],
    build: match[5] || ''
  };
}

export function isPrerelease(version) {
  const parsed = parseSemver(version);
  return !!parsed && parsed.prerelease.length > 0;
}

export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new Error('发行版本号格式无效');
  for (const field of ['major', 'minor', 'patch']) {
    const diff = compareNumericStrings(a[field], b[field]);
    if (diff !== 0) return diff;
  }
  const aPre = a.prerelease;
  const bPre = b.prerelease;
  if (!aPre.length && !bPre.length) return 0;
  if (!aPre.length) return 1;
  if (!bPre.length) return -1;
  const len = Math.max(aPre.length, bPre.length);
  for (let i = 0; i < len; i++) {
    if (i >= aPre.length) return -1;
    if (i >= bPre.length) return 1;
    const x = aPre[i];
    const y = bPre[i];
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const diff = compareNumericStrings(x, y);
      if (diff !== 0) return diff;
      continue;
    }
    if (xNum !== yNum) return xNum ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function isNewerVersion(candidate, current) {
  return compareSemver(candidate, current) > 0;
}

export function classifyPeerCompatibility(localVersion, peerStatus) {
  const peerVersion = typeof peerStatus?.version === 'string' ? peerStatus.version.trim() : '';
  const hasValidVersions = !!parseSemver(localVersion) && !!parseSemver(peerVersion);
  const cmp = hasValidVersions ? compareSemver(peerVersion, localVersion) : 0;
  const peerNewer = cmp > 0;
  const peerOlder = cmp < 0;
  const hasRules = peerStatus && typeof peerStatus.rules === 'object' && peerStatus.rules !== null;
  // Older launchers before hot-update do not expose status.rules; let WebRTC hello verify them.
  const compatible = hasRules ? rulesCompatible(peerStatus.rules) : true;

  if (!compatible) {
    return {
      compatible: false,
      peerNewer,
      peerOlder,
      peerVersion,
      action: peerNewer ? 'block_update_self' : peerOlder ? 'block_update_peer' : 'block_incompatible'
    };
  }
  return {
    compatible: true,
    peerNewer,
    peerOlder,
    peerVersion,
    action: peerNewer ? 'connect_with_hint' : 'connect'
  };
}

export function parseGithubReleaseInput(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('请粘贴 GitHub Release 链接');
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('GitHub Release 链接格式无效');
  }
  if (url.username || url.password) throw new Error('发行版链接不能包含认证信息');
  const isLocalTest = url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if (!isLocalTest) {
    if (url.protocol !== 'https:') throw new Error('发行版链接必须使用 HTTPS 地址');
    if (url.hostname.toLowerCase() !== 'github.com' || (url.port && url.port !== '443')) {
      throw new Error('仅支持 https://github.com 的发行版链接');
    }
  }
  const cleanPath = url.pathname.replace(/\/+$/, '');
  const tagMatch = /^\/([^/]+)\/([^/]+)\/releases\/tag\/([vV]([^/]+))$/.exec(cleanPath);
  if (tagMatch) {
    const [, owner, repo, tag, version] = tagMatch;
    if (!parseSemver(version) || version.includes('+')) throw new Error('发行版链接中的版本号无效');
    const downloadUrl = `${url.origin}/${owner}/${repo}/releases/download/${tag}/fishcome-${version}-windows.zip`;
    return { kind: 'tag', owner, repo, tag, version, downloadUrl, sourceLabel: `${url.origin}${cleanPath}` };
  }
  const assetMatch = /^\/([^/]+)\/([^/]+)\/releases\/download\/([vV]([^/]+))\/fishcome-([^/]+)-windows\.zip$/.exec(cleanPath);
  if (assetMatch) {
    const [, owner, repo, tag, tagVersion, fileVersion] = assetMatch;
    if (!parseSemver(fileVersion) || fileVersion.includes('+') || tagVersion !== fileVersion) {
      throw new Error('发布包链接中的标签版本与文件名版本不一致或无效');
    }
    const downloadUrl = `${url.origin}${cleanPath}`;
    return { kind: 'asset', owner, repo, tag, version: fileVersion, downloadUrl, sourceLabel: downloadUrl };
  }
  throw new Error('请粘贴具体的 GitHub Release 页面链接（/releases/tag/vX.Y.Z）或 Windows 便携包直链');
}
