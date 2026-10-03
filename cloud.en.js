/* ══════════════════════════════════════════════════════════════════
   归处 · 云端接入
   ──────────────────────────────────────────────────────────────────
   这个文件负责「怎么连、怎么调、出错怎么办」。

   站上的每一个字仍然在 content.js 里 —— 连模型的系统提示词、每一句
   出错提示，都在那边。这里不写文案。

   两个能力，同一个云服务环境：
     · 问答    llm       —— 免密钥的大模型调用，流式返回
     · 留言墙  database  —— 读写云端 wall_lines 表

   ⚠️ 两件必须知道的事：

   1. 云服务会校验访问来源（Origin）。这套东西只在正式域名上生效：
        https://ai-home.app.workbuddy.host
      在本机用 file:// 或别的地址打开时，问答会退回 content.js 里
      已经写好的那些回答，留言墙会显示「连不上」。这是预期行为，不是坏了。

   2. keyless 不等于没有成本。这条通道挂在「归处」这个应用名下，
      额度是有限的，所以凡是访客能触发的调用都做了节流。
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var G = window.GUICHU || {};

  /* ── 这个应用的云端坐标 ──
     由 WorkBuddy 云服务在开通时分配。endpoint 必须显式传，
     不能靠 SDK 的同源兜底；publishableKey 只标识是哪个应用，
     本身不带权限（服务端按 Origin 校验）。 */
  var CFG = {
    endpoint: 'https://ai-home.app.workbuddy.host',
    publishableKey: 'wbpk_iPCgRJaN5U2YZXfNnUesWw_sDckdfOctRWR6V058BuhqRIuXzgeG5E9'
  };

  /* 这个站点没有构建步骤，SDK 走 CDN 的 IIFE 版本，全局名是 WorkBuddyCloud */
  var SDK_URL = 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';

  var WALL_TABLE = 'wall_lines';
  var WALL_MAX = 140;          /* 和数据库那边的 CHECK 约束一致 */
  var WALL_LIMIT = 60;         /* 一次最多读这么多条 */

  var ASK_MAX = 300;           /* 单次提问最长字数 */
  var ASK_COOLDOWN = 6000;     /* 两次提问之间至少隔这么久 */
  var ASK_HOURLY = 20;         /* 每个浏览器每小时最多问这么多 */
  var WALL_COOLDOWN = 15000;   /* 两次留言之间至少隔这么久 */
  var WALL_HOURLY = 10;

  /* ── 节流账本 ──
     只记时间戳，不记内容、不记身份。同一台机器换个浏览器就重来，
     这不是防攻击，只是别让一个人的手速把额度抽干。 */
  var SPEND_KEY = 'aijia.spend';

  function readSpend() {
    try {
      var raw = localStorage.getItem(SPEND_KEY);
      var o = raw ? JSON.parse(raw) : null;
      if (!o || typeof o !== 'object') return { ask: [], wall: [] };
      return { ask: o.ask || [], wall: o.wall || [] };
    } catch (e) { return { ask: [], wall: [] }; }
  }

  function writeSpend(o) {
    try { localStorage.setItem(SPEND_KEY, JSON.stringify(o)); } catch (e) { /* 无痕模式，放弃记录 */ }
  }

  function prune(list) {
    var cut = Date.now() - 3600000;
    return (list || []).filter(function (t) { return t > cut; });
  }

  /* 返回 null 表示放行，否则返回还差多少毫秒 */
  function throttle(kind, cooldown, hourly) {
    var o = readSpend();
    var list = prune(o[kind]);
    o[kind] = list;
    writeSpend(o);

    if (list.length >= hourly) return { wait: 0, capped: true };
    var last = list.length ? list[list.length - 1] : 0;
    var gap = cooldown - (Date.now() - last);
    if (gap > 0) return { wait: gap, capped: false };
    return null;
  }

  function spend(kind) {
    var o = readSpend();
    o[kind] = prune(o[kind]);
    o[kind].push(Date.now());
    writeSpend(o);
  }

  function remaining(kind, hourly) {
    return Math.max(0, hourly - prune(readSpend()[kind]).length);
  }

  /* ── 错误码翻译 ──
     只按稳定的 code 前缀分类，不读 SDK 私有字段。 */
  function mapError(err) {
    var code = (err && err.error && err.error.code) || (err && err.code) || '';
    var M = (G.ai && G.ai.errors) || {};
    var key = 'other';

    if (/^request_/.test(code)) key = 'request';
    else if (/^auth_/.test(code)) key = 'auth';
    else if (/^quota_/.test(code)) key = 'quota';
    else if (/^gateway_|^model_/.test(code)) key = 'gateway';
    else if (/^internal_/.test(code)) key = 'internal';
    else if (!navigator.onLine) key = 'offline';

    /* 只把 requestId 留下来给人报障，不往外抛内部栈 */
    return {
      code: code,
      requestId: err && err.requestId,
      message: M[key] || M.other || 'Something went wrong. Try again in a while.'
    };
  }

  var API = {
    state: 'loading',     /* loading | ready | offline */
    cloud: null,
    model: null,
    models: [],
    error: null,
    askMax: ASK_MAX,
    wallMax: WALL_MAX,
    askLeft: 0,
    wallLeft: 0
  };
  window.AIJIA = API;

  function loadSDK() {
    return new Promise(function (resolve, reject) {
      if (window.WorkBuddyCloud) { resolve(window.WorkBuddyCloud); return; }
      var s = document.createElement('script');
      s.src = SDK_URL;
      s.async = true;
      s.onload = function () {
        if (window.WorkBuddyCloud) resolve(window.WorkBuddyCloud);
        else reject(new Error('sdk_global_missing'));
      };
      s.onerror = function () { reject(new Error('sdk_load_failed')); };
      document.head.appendChild(s);
    });
  }

  /* ── 启动 ──
     任何一步失败都不抛给页面：站点会退回本来的样子（已经写好的回答），
     只是问答不再实时生成。 */
  var ready = loadSDK()
    .then(function (WBC) {
      API.cloud = WBC.createWorkBuddyCloud({
        endpoint: CFG.endpoint,
        publishableKey: CFG.publishableKey
      });
      return API.cloud.llm.models.list();
    })
    .then(function (models) {
      API.models = Array.isArray(models) ? models : [];
      /* 空列表是合法结果，不能拿一个写死的模型 id 顶上 */
      API.model = API.models.filter(function (m) { return m && m.disabled !== true; })[0] || null;
      API.askLeft = remaining('ask', ASK_HOURLY);
      API.wallLeft = remaining('wall', WALL_HOURLY);
      API.state = API.model ? 'ready' : 'offline';
      return API.state;
    })
    .catch(function (err) {
      API.error = mapError(err);
      API.state = 'offline';
      return 'offline';
    });

  API.ready = ready;

  /* ═══════════ 问答 ═══════════ */

  /* 流式问一次。
     返回一个句柄，handlers.onDelta(增量, 累计全文) 会一路被调用。 */
  API.ask = function (question, handlers) {
    handlers = handlers || {};
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var handle = { text: '', stopped: false };
    handle.stop = function () {
      handle.stopped = true;
      if (ctl) ctl.abort();
    };

    if (API.state !== 'ready' || !API.cloud || !API.model) {
      setTimeout(function () {
        (handlers.onError || function () {})({
          code: 'not_ready',
          message: (API.error && API.error.message) ||
                   ((G.ai && G.ai.errors && G.ai.errors.other) || 'There is no connection right now.')
        });
      }, 0);
      return handle;
    }

    var gate = throttle('ask', ASK_COOLDOWN, ASK_HOURLY);
    if (gate) {
      setTimeout(function () {
        (handlers.onError || function () {})({
          code: gate.capped ? 'local_hourly' : 'local_cooldown',
          waitMs: gate.wait,
          message: gate.capped
            ? ((G.ai && G.ai.errors && G.ai.errors.local_hourly) || 'That is a lot of questions for today. Come back in a while.')
            : ((G.ai && G.ai.errors && G.ai.errors.local_cooldown) || 'Take a breath. Wait a moment before asking again.')
        });
      }, 0);
      return handle;
    }
    spend('ask');
    API.askLeft = remaining('ask', ASK_HOURLY);

    /* messages[0] 必须是应用自己的 system —— 少了大模型会直接报错。
       访客的话只进 user 那一条，绝不拼进 system，免得被指令注入带走。 */
    var sys = (G.ai && G.ai.system) || '';
    var messages = [
      { role: 'system', content: Array.isArray(sys) ? sys.join('\n') : String(sys) },
      { role: 'user', content: String(question) }
    ];

    (async function () {
      try {
        for await (const chunk of API.cloud.llm.chat.completions.create({
          model: API.model.id,
          messages: messages,
          stream: true,
          stream_options: { include_usage: true },
          signal: ctl ? ctl.signal : undefined
        })) {
          const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
          if (d && d.content) {
            handle.text += d.content;
            if (handlers.onDelta) handlers.onDelta(d.content, handle.text);
          }
        }
        if (handlers.onDone) handlers.onDone(handle.text, handle.stopped);
      } catch (err) {
        /* 自己按停的不算错，已经吐出来的字要留住 */
        if (handle.stopped) {
          if (handlers.onDone) handlers.onDone(handle.text, true);
          return;
        }
        if (handlers.onError) handlers.onError(mapError(err));
      }
    })();

    return handle;
  };

  /* ═══════════ 留言墙 ═══════════ */

  function unwrap(res) {
    if (res && res.error) throw res.error;
    return res ? res.data : null;
  }

  API.wall = {
    list: function (limit) {
      if (API.state !== 'ready' || !API.cloud) {
        return Promise.reject({
          code: 'not_ready',
          message: (API.error && API.error.message) || 'The words on the wall cannot be read right now.'
        });
      }
      return API.cloud.database
        .from(WALL_TABLE)
        .select('id, body, created_at')
        .order('created_at', { ascending: false })
        .limit(limit || WALL_LIMIT)
        .then(function (res) {
          var rows = unwrap(res);
          return Array.isArray(rows) ? rows : [];
        });
    },

    add: function (body) {
      if (API.state !== 'ready' || !API.cloud) {
        return Promise.reject({
          code: 'not_ready',
          message: (API.error && API.error.message) || 'It cannot be written up right now.'
        });
      }
      var text = String(body == null ? '' : body).trim();
      if (!text) return Promise.reject({ code: 'empty', message: (G.ui && G.ui.wall && G.ui.wall.empty) || 'There is nothing in it, so there is nothing to hang up.' });
      if (text.length > WALL_MAX) return Promise.reject({ code: 'too_long', message: 'Too long \u2014 keep it under ' + WALL_MAX + ' characters.' });

      var gate = throttle('wall', WALL_COOLDOWN, WALL_HOURLY);
      if (gate) {
        return Promise.reject({
          code: gate.capped ? 'local_hourly' : 'local_cooldown',
          waitMs: gate.wait,
          message: gate.capped
            ? ((G.ai && G.ai.errors && G.ai.errors.wall_hourly) || 'One line at a time. Come back in a while.')
            : ((G.ai && G.ai.errors && G.ai.errors.wall_cooldown) || 'Slower. You just hung one up.')
        });
      }

      return API.cloud.database
        .from(WALL_TABLE)
        .insert({ body: text })
        .select()
        .then(function (res) {
          var rows = unwrap(res);
          /* 什么都没回来说明权限拦了 —— 别当成写成功 */
          if (!Array.isArray(rows) || rows.length === 0) {
            throw { code: 'denied', message: (G.ai && G.ai.errors && G.ai.errors.wall_denied) || 'This line did not make it onto the wall.' };
          }
          spend('wall');
          API.wallLeft = remaining('wall', WALL_HOURLY);
          return rows[0];
        }, function (err) { throw mapError(err); });
    }
  };

  API.reloadWall = function () {
    API.wallLeft = remaining('wall', WALL_HOURLY);
    return API.wall.list();
  };
})();
