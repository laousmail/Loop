// Google Drive access for public ("anyone with the link") files, using the
// Drive v3 REST API with an API key. Browsers can't read drive.google.com
// download links directly (no CORS), but googleapis.com allows it.

const API = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const AUDIO_EXT = /\.(wav|wave|mp3|m4a|aac|mp4|flac|ogg|oga|opus|aif|aiff|aifc|caf|webm)$/i;

export class DriveError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** Pull folder/file ids (and resource keys) out of pasted text. */
export function parseDriveLinks(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text).split(/[\s,]+/)) {
    const s = raw.trim();
    if (!s) continue;
    let id = null, kind = 'unknown', resourceKey = null;
    let url = null;
    try { url = new URL(s); } catch { /* not a URL */ }
    if (url) {
      if (!/(^|\.)google\.com$/.test(url.hostname)) continue;
      resourceKey = url.searchParams.get('resourcekey');
      let m;
      if ((m = url.pathname.match(/\/folders\/([\w-]{10,})/))) { id = m[1]; kind = 'folder'; }
      else if ((m = url.pathname.match(/\/(?:file\/)?d\/([\w-]{10,})/))) { id = m[1]; kind = 'file'; }
      else if (url.searchParams.get('id')) id = url.searchParams.get('id');
    } else if (/^[\w-]{20,}$/.test(s)) {
      id = s;
    }
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push({ id, kind, resourceKey });
    }
  }
  return out;
}

export const isAudioFile = (f) =>
  (f.mimeType || '').startsWith('audio/') || AUDIO_EXT.test(f.name || '');

const keyHeader = (items) => {
  const parts = items.filter((i) => i.resourceKey).map((i) => `${i.id}/${i.resourceKey}`);
  return parts.length ? { 'X-Goog-Drive-Resource-Keys': parts.join(',') } : {};
};

async function toDriveError(res) {
  let reason = '', message = '';
  try {
    const j = await res.json();
    reason = j.error?.errors?.[0]?.reason || '';
    message = j.error?.message || '';
    for (const d of j.error?.details || []) if (d.reason) reason += ' ' + d.reason;
  } catch { /* not JSON */ }
  const text = `${reason} ${message}`;
  if (/API_KEY_INVALID|keyInvalid|API key not valid/i.test(text)) {
    return new DriveError('Google rejected that API key. Check it in Settings (gear icon, top right).', 'key');
  }
  if (/REFERRER|referer|blocked/i.test(text) && /key/i.test(text)) {
    return new DriveError('Your API key doesn’t allow requests from this site. Add this site’s address to the key’s website restrictions in Google Cloud.', 'key-referrer');
  }
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used|is disabled/i.test(text)) {
    return new DriveError('The Google Drive API is turned off for your API key’s project. Enable “Google Drive API” in Google Cloud Console, wait a minute, then try again.', 'api-disabled');
  }
  if (/rateLimit|quota|dailyLimit/i.test(text)) {
    return new DriveError('Google Drive is limiting requests right now. Wait a minute and try again.', 'rate');
  }
  if (res.status === 404 || res.status === 403) {
    return new DriveError('Couldn’t open that link. In Drive, set sharing to “Anyone with the link” for the folder, then try again.', 'not-shared');
  }
  return new DriveError(`Google Drive returned an error (${res.status}). Try again in a moment.`, 'http');
}

async function api(path, params, key, items = []) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('key', key);
  let res;
  try {
    res = await fetch(url, { headers: keyHeader(items) });
  } catch {
    throw new DriveError('Can’t reach Google Drive. Check your connection and try again.', 'network');
  }
  if (!res.ok) throw await toDriveError(res);
  return res;
}

const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,resourceKey';

async function getMeta(item, key) {
  const res = await api(`/files/${item.id}`, { fields: FILE_FIELDS }, key, [item]);
  return res.json();
}

async function listFolder(folder, key) {
  const files = [];
  let pageToken = '';
  do {
    const params = {
      q: `'${folder.id}' in parents and trashed = false`,
      fields: `nextPageToken, files(${FILE_FIELDS})`,
      pageSize: '200',
      includeItemsFromAllDrives: 'true',
      orderBy: 'name_natural',
    };
    if (pageToken) params.pageToken = pageToken;
    const res = await api('/files', params, key, [folder]);
    const j = await res.json();
    files.push(...(j.files || []));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return files;
}

/**
 * Resolve pasted links into a list of audio files.
 * @returns {Promise<{name: string, files: object[]}>}
 */
export async function resolveDriveSource(links, key) {
  const files = [];
  let name = '';
  for (const link of links) {
    const info = await getMeta(link, key);
    if (info.mimeType === FOLDER_MIME) {
      const folder = { id: link.id, resourceKey: link.resourceKey || info.resourceKey };
      name ||= info.name || 'Drive folder';
      const children = await listFolder(folder, key);
      files.push(...children.filter((f) => f.mimeType !== FOLDER_MIME));
    } else {
      files.push({ ...info, resourceKey: info.resourceKey || link.resourceKey });
      name ||= info.name;
    }
  }
  return { name: name || 'Drive tracks', files };
}

/** Download one file's bytes, reporting progress 0..1. */
export async function downloadFile(file, key, onProgress) {
  const res = await api(`/files/${file.id}`, { alt: 'media' }, key, [file]);
  const total = Number(res.headers.get('content-length')) || Number(file.size) || 0;
  if (!res.body || !total) {
    const buf = await res.arrayBuffer();
    onProgress?.(1);
    return buf;
  }
  const reader = res.body.getReader();
  const out = new Uint8Array(total);
  let got = 0;
  let extra = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length <= total) out.set(value, got);
    else extra.push(value);
    got += value.length;
    onProgress?.(Math.min(1, got / total));
  }
  if (!extra.length) return out.buffer.slice(0, got);
  // Content-length was wrong (e.g. compressed); stitch it together.
  const all = new Uint8Array(got);
  all.set(out.subarray(0, total), 0);
  let o = total;
  for (const v of extra) { all.set(v, o); o += v.length; }
  return all.buffer;
}
