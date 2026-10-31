// Dropbox 폴더를 PC 폴더와 같은 방식(values, getFileHandle, createWritable 등)으로 다루게 해 주는 층.
// 앱 본체는 폴더가 PC에 있는지 Dropbox에 있는지 구분하지 않아도 된다.
const Dbx = {
  key: 'r5x3zw22oc0ovgt', // Dropbox 앱의 App key (비밀값이 아니다)
  defaultPath: '/SBSA/KAKASHI',
  LIST_TTL: 15000,
  MAX_DOWNLOADS: 6,
  active: 0, waiting: [], inflight: new Map(), pending: null, access: null, accessUntil: 0,

  conf() { try { return JSON.parse(localStorage.getItem('kakashi.dbx') || 'null'); } catch { return null; } },
  setConf(c) { try { c ? localStorage.setItem('kakashi.dbx', JSON.stringify(c)) : localStorage.removeItem('kakashi.dbx'); } catch {} },
  root() { const c = this.conf(); return c && new DbxDir(c.path, c.path.split('/').pop()); },

  /* ---------- 로그인: 화면에 나온 코드를 붙여넣는 방식 ----------
     주소 되돌리기(redirect) 방식은 아이폰 홈 화면 앱에서 저장 공간이 달라 실패하므로 쓰지 않는다 */
  async startLogin() {
    const rand = crypto.getRandomValues(new Uint8Array(48));
    const b64 = b => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const verifier = b64(rand);
    localStorage.setItem('kakashi.dbxVerifier', verifier);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    return 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({
      client_id: this.key, response_type: 'code', token_access_type: 'offline',
      code_challenge: b64(hash), code_challenge_method: 'S256',
      scope: 'files.metadata.read files.content.read files.content.write',
    });
  },
  async token(params) {
    const r = await this.net('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST', body: new URLSearchParams({ client_id: this.key, ...params }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error_description || d.error || '인증 실패');
    this.access = d.access_token;
    this.accessUntil = Date.now() + (d.expires_in - 60) * 1000;
    return d;
  },
  async finishLogin(code) {
    const d = await this.token({
      grant_type: 'authorization_code', code: code.trim(),
      code_verifier: localStorage.getItem('kakashi.dbxVerifier') || '',
    });
    this.setConf({ refresh: d.refresh_token, path: this.defaultPath });
    localStorage.removeItem('kakashi.dbxVerifier');
  },
  async setPath(path) {
    const c = this.conf();
    c.path = path;
    this.setConf(c);
  },
  async logout() {
    try { await this.api('https://api.dropboxapi.com/2/auth/token/revoke', { method: 'POST' }); } catch {}
    this.setConf(null);
    this.access = null;
  },

  /* ---------- 요청 ---------- */
  async net(url, opts) {
    try { return await fetch(url, opts); }
    catch (e) {
      const err = new Error('인터넷 연결을 확인하세요');
      err.offline = true;
      throw err;
    }
  },
  async bearer(force) {
    if (force || !this.access || Date.now() > this.accessUntil) {
      const c = this.conf();
      if (!c) throw new Error('Dropbox가 연결되어 있지 않습니다');
      await this.token({ grant_type: 'refresh_token', refresh_token: c.refresh });
    }
    return this.access;
  },
  async api(url, opts, retried) {
    const r = await this.net(url, { ...opts, headers: { ...opts.headers, Authorization: 'Bearer ' + await this.bearer(retried === 401) } });
    if (r.status === 401 && !retried) return this.api(url, opts, 401);
    if (r.status === 429 && retried !== 429) {
      const wait = +r.headers.get('Retry-After') || 2;
      await new Promise(res => setTimeout(res, wait * 1000));
      return this.api(url, opts, 429);
    }
    if (!r.ok) {
      const text = await r.text();
      let summary = text;
      try { summary = JSON.parse(text).error_summary || text; } catch {}
      const err = new Error('Dropbox 오류: ' + summary);
      err.summary = summary;
      throw err;
    }
    return r;
  },
  rpc(name, arg) {
    return this.api('https://api.dropboxapi.com/2/' + name, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(arg),
    }).then(r => r.json());
  },
  // Dropbox-API-Arg 헤더에는 한글을 그대로 넣을 수 없다
  argHeader(arg) {
    return JSON.stringify(arg).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  },
  async limit(fn) {
    if (this.active >= this.MAX_DOWNLOADS) await new Promise(res => this.waiting.push(res));
    this.active++;
    try { return await fn(); }
    finally { this.active--; this.waiting.shift()?.(); }
  },
  async upload(path, blob, mode) {
    const r = await this.api('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': this.argHeader({ path, mode, autorename: mode === 'add', mute: true }),
      },
      body: blob,
    });
    return r.json();
  },

  /* ---------- 인터넷이 끊겼을 때 녹음을 잃지 않도록 보관했다가 올린다 ---------- */
  async pendingList() {
    if (!this.pending) this.pending = (await kvGet('dbxPending')) || [];
    return this.pending;
  },
  async flush() {
    const list = await this.pendingList();
    for (const p of [...list]) {
      await this.upload(p.path, p.blob, 'add');
      list.splice(list.indexOf(p), 1);
      await kvSet('dbxPending', list);
    }
  },
};
const dbxKey = s => s.normalize('NFC').toLowerCase();

class DbxFile {
  kind = 'file';
  constructor(parent, name, path, rev) { this.parent = parent; this.name = name; this.path = path; this.rev = rev; }
  async getFile() {
    const held = (await Dbx.pendingList()).find(p => p.path === this.path);
    if (held) return held.blob;
    const key = 'dbxBlob:' + dbxKey(this.path);
    const cached = await kvGet(key);
    if (cached && cached.rev === this.rev) return cached.blob;
    const job = key + ':' + this.rev;
    if (!Dbx.inflight.has(job)) {
      Dbx.inflight.set(job, Dbx.limit(async () => {
        const r = await Dbx.api('https://content.dropboxapi.com/2/files/download', {
          method: 'POST', headers: { 'Dropbox-API-Arg': Dbx.argHeader({ path: this.path }) },
        });
        // 아이폰은 형식이 지정되지 않은 파일을 재생하지 못한다
        const type = /\.mp3$/i.test(this.name) ? 'audio/mpeg' : 'text/plain';
        const blob = new Blob([await r.blob()], { type });
        await kvSet(key, { rev: this.rev, blob });
        return blob;
      }).finally(() => Dbx.inflight.delete(job)));
    }
    return Dbx.inflight.get(job);
  }
  async createWritable() {
    const parts = [];
    return {
      write: async b => { parts.push(b); },
      close: async () => {
        const blob = new Blob(parts, { type: /\.mp3$/i.test(this.name) ? 'audio/mpeg' : 'application/json' });
        // 기록 파일만 덮어쓰고, 녹음은 같은 이름이 있어도 지우지 않는다
        const isTake = /\.mp3$/i.test(this.name);
        try {
          const meta = await Dbx.upload(this.path, blob, isTake ? 'add' : 'overwrite');
          this.rev = meta.rev;
          await kvSet('dbxBlob:' + dbxKey(meta.path_display), { rev: meta.rev, blob });
        } catch (e) {
          if (!e.offline || !isTake) throw e;
          const list = await Dbx.pendingList();
          list.push({ path: this.path, blob });
          await kvSet('dbxPending', list);
          this.rev = 'pending';
        }
        this.parent.refresh();
      },
    };
  }
}

class DbxDir {
  kind = 'directory';
  constructor(path, name) { this.path = path; this.name = name; this.list = null; this.at = 0; }
  queryPermission() { return 'granted'; }
  requestPermission() { return 'granted'; }
  refresh() { this.at = 0; }
  async entries(force) {
    if (!force && this.list && Date.now() - this.at < Dbx.LIST_TTL) return this.list;
    const listKey = 'dbxList:' + dbxKey(this.path);
    let out = [];
    try {
      let page = await Dbx.rpc('files/list_folder', { path: this.path });
      out = page.entries;
      while (page.has_more) {
        page = await Dbx.rpc('files/list_folder/continue', { cursor: page.cursor });
        out = out.concat(page.entries);
      }
      out = out.map(e => ({ tag: e['.tag'], name: e.name, path: e.path_display, rev: e.rev }));
      await kvSet(listKey, out);
    } catch (e) {
      const saved = e.offline && await kvGet(listKey);
      if (!saved) throw e;
      out = saved;
    }
    // 아직 올리지 못한 녹음도 목록에 보이게 한다
    const prefix = dbxKey(this.path) + '/';
    for (const p of await Dbx.pendingList()) {
      const k = dbxKey(p.path);
      if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/') && !out.some(e => dbxKey(e.path) === k)) {
        out.push({ tag: 'file', name: p.path.split('/').pop(), path: p.path, rev: 'pending' });
      }
    }
    this.list = out;
    this.at = Date.now();
    return out;
  }
  wrap(e) { return e.tag === 'folder' ? new DbxDir(e.path, e.name) : new DbxFile(this, e.name, e.path, e.rev); }
  async *values() { for (const e of await this.entries()) if (e.tag === 'folder' || e.tag === 'file') yield this.wrap(e); }
  // Mac과 Windows는 한글 파일 이름을 다르게 저장하므로 맞춰서 비교한다
  async find(name, tag) {
    const k = dbxKey(name);
    return (await this.entries()).find(e => e.tag === tag && dbxKey(e.name) === k);
  }
  async getDirectoryHandle(name, opts = {}) {
    const e = await this.find(name, 'folder');
    if (e) return this.wrap(e);
    if (!opts.create) throw new DOMException('없는 폴더', 'NotFoundError');
    const path = this.path + '/' + name;
    await Dbx.rpc('files/create_folder_v2', { path, autorename: false });
    this.refresh();
    return new DbxDir(path, name);
  }
  async getFileHandle(name, opts = {}) {
    const e = await this.find(name, 'file');
    if (e) return this.wrap(e);
    if (!opts.create) throw new DOMException('없는 파일', 'NotFoundError');
    return new DbxFile(this, name, this.path + '/' + name, null);
  }
  async removeEntry(name) {
    const e = await this.find(name, 'file');
    if (!e) return;
    await Dbx.rpc('files/delete_v2', { path: e.path });
    await kvSet('dbxBlob:' + dbxKey(e.path), undefined);
    this.refresh();
  }
}
