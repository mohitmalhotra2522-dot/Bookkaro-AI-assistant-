/*
 * BookKaro IRCTC Assist — P39.3 handoff guard (UMD: global `BookKaroHandoffGuard` in the service worker / content
 * script, CommonJS for tests). Pure checks, no network, no storage:
 *
 *  - isApprovedIrctcPage(url): autofill ONLY on https://www.irctc.co.in/nget/* (exact host, no wildcard) or the local
 *    MockIRCTC (http://localhost|127.0.0.1[:port]/api/dev/mock-irctc*). Anything else → UNAUTHORIZED_IRCTC_HOST.
 *  - validateSnapshotSchema(s): strict allow-list of keys + types (no raw LLM text / transcript can ride along).
 *  - checkBinding(s, expected, now): handoffId + reviewVersion bound at registration, expiry, backend status.
 *  - verifyIntegrity(s, key, subtle): HMAC-SHA256(bridge token) over the canonical validated payload.
 *  - guardSnapshot(...): all of the above → { ok:true, snapshot } | { ok:false, code:'STALE_IRCTC_HANDOFF', reason }.
 * Mirrors shared/irctc-handoff.ts (IRCTC_INTEGRITY_FIELDS, canonicalJson, IRCTC_HANDOFF_SCHEMA_VERSION).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BookKaroHandoffGuard = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCHEMA_VERSION = 1;
  var APPROVED_HOST = 'www.irctc.co.in';
  var APPROVED_PATH = '/nget/';
  var MOCK_HOSTS = ['localhost', '127.0.0.1'];
  var MOCK_PATH = '/api/dev/mock-irctc';
  var INTEGRITY_FIELDS = ['schemaVersion', 'handoffId', 'sourceReviewVersion', 'createdAt', 'expiresAt', 'mockData', 'journey', 'train', 'travelClass', 'quota', 'passengers'];
  var TOP_KEYS = ['handoffId', 'status', 'createdAt', 'expiresAt', 'language', 'mockData', 'journey', 'train', 'travelClass', 'quota', 'passengers',
    'userActions', 'notConfirmed', 'message', 'schemaVersion', 'sourceReviewVersion', 'integrity'];
  var STATUSES = ['READY', 'LANGUAGE_SELECTION', 'LOGIN_REQUIRED', 'JOURNEY_PAGE', 'TRAIN_LIST', 'PASSENGER_PAGE', 'READY_FOR_USER_BOOK', 'CAPTCHA_REQUIRED',
    'OTP_REQUIRED', 'PAYMENT_PAGE', 'PAUSED', 'SESSION_EXPIRED', 'COMPLETED', 'BOOKING_FAILED', 'BOOKING_STATUS_UNKNOWN', 'EXPIRED', 'STALE_HANDOFF', 'STOPPED'];
  var HANDOFF_ID_RE = /^irh_[0-9a-f-]{36}$/;

  /** Approved autofill page? → { ok, kind:'REAL'|'MOCK' } | { ok:false, code:'UNAUTHORIZED_IRCTC_HOST' } */
  function isApprovedIrctcPage(href) {
    var u;
    try { u = new URL(String(href)); } catch (e) { return { ok: false, code: 'UNAUTHORIZED_IRCTC_HOST' }; }
    if (u.protocol === 'https:' && u.hostname === APPROVED_HOST && !u.port && u.pathname.indexOf(APPROVED_PATH) === 0) return { ok: true, kind: 'REAL' };
    if (u.protocol === 'http:' && MOCK_HOSTS.indexOf(u.hostname) >= 0 && (u.pathname === MOCK_PATH || u.pathname.indexOf(MOCK_PATH + '/') === 0)) return { ok: true, kind: 'MOCK' };
    return { ok: false, code: 'UNAUTHORIZED_IRCTC_HOST' };
  }

  function canonicalJson(v) {
    if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canonicalJson(v[k]); }).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  function integrityPayload(s) { var o = {}; INTEGRITY_FIELDS.forEach(function (k) { o[k] = s[k]; }); return canonicalJson(o); }

  var isStr = function (v, re) { return typeof v === 'string' && (!re || re.test(v)); };
  var isNullStr = function (v) { return v === null || typeof v === 'string'; };
  var isInt = function (v, lo, hi) { return typeof v === 'number' && Math.floor(v) === v && v >= lo && v <= hi; };
  function onlyKeys(o, keys) { return !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(function (k) { return keys.indexOf(k) >= 0; }); }

  function station(st) {
    return onlyKeys(st, ['code', 'display', 'query']) && isStr(st.code, /^[A-Z0-9]{1,6}$/) && isNullStr(st.display) && isStr(st.query, /^[A-Z0-9]{1,6}$/) && st.query === st.code;
  }

  /** Strict schema: only the validated handoff contract, nothing else (no raw LLM output, no transcript). */
  function validateSnapshotSchema(s) {
    if (!onlyKeys(s, TOP_KEYS)) return 'UNKNOWN_KEYS';
    for (var i = 0; i < TOP_KEYS.length; i++) if (!(TOP_KEYS[i] in s)) return 'MISSING_' + TOP_KEYS[i];
    if (s.schemaVersion !== SCHEMA_VERSION) return 'SCHEMA_VERSION';
    if (!isStr(s.handoffId, HANDOFF_ID_RE)) return 'HANDOFF_ID';
    if (STATUSES.indexOf(s.status) < 0) return 'STATUS';
    if (!isStr(s.createdAt) || isNaN(Date.parse(s.createdAt)) || !isStr(s.expiresAt) || isNaN(Date.parse(s.expiresAt))) return 'TIMES';
    if (Date.parse(s.expiresAt) <= Date.parse(s.createdAt)) return 'TIMES';
    if (s.language !== 'en' && s.language !== 'hi') return 'LANGUAGE';
    if (typeof s.mockData !== 'boolean') return 'MOCK_FLAG';
    if (!isInt(s.sourceReviewVersion, 1, 1e6)) return 'REVIEW_VERSION';
    if (!isStr(s.integrity, /^[0-9a-f]{64}$/)) return 'INTEGRITY';
    var j = s.journey;
    if (!onlyKeys(j, ['from', 'to', 'dateIso', 'dateIrctc']) || !station(j.from) || !station(j.to) || j.from.code === j.to.code) return 'JOURNEY';
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(j.dateIso || '');
    if (!m || j.dateIrctc !== m[3] + '/' + m[2] + '/' + m[1]) return 'DATE';
    var t = s.train;
    if (!onlyKeys(t, ['number', 'name', 'departure', 'arrival']) || !isStr(t.number, /^\d{5}$/) || !isNullStr(t.name) || !isNullStr(t.departure) || !isNullStr(t.arrival)) return 'TRAIN';
    if (!onlyKeys(s.travelClass, ['code', 'label']) || !isStr(s.travelClass.code, /^[0-9A-Z]{2}$/) || !isNullStr(s.travelClass.label)) return 'CLASS';
    if (s.travelClass.label && s.travelClass.label.indexOf('(' + s.travelClass.code + ')') < 0) return 'CLASS';
    if (!onlyKeys(s.quota, ['code', 'label']) || s.quota.code !== 'GN' || s.quota.label !== 'GENERAL') return 'QUOTA';
    var P = s.passengers;
    if (!Array.isArray(P) || P.length < 1 || P.length > 6) return 'PASSENGERS';
    for (var p = 0; p < P.length; p++) {
      var x = P[p];
      if (!onlyKeys(x, ['index', 'name', 'age', 'gender', 'berth', 'food'])) return 'PASSENGER_KEYS';
      if (x.index !== p + 1) return 'PASSENGER_ORDER';                       // never reordered, never invented
      if (!isStr(x.name) || !x.name.trim() || x.name.length > 60 || !isInt(x.age, 1, 125)) return 'PASSENGER_VALUES';
      if (x.gender !== null && ['Male', 'Female', 'Transgender'].indexOf(x.gender) < 0) return 'PASSENGER_GENDER';
      if (!isNullStr(x.berth) || !isNullStr(x.food)) return 'PASSENGER_OPTIONS';
    }
    if (!Array.isArray(s.userActions) || !Array.isArray(s.notConfirmed) || typeof s.message !== 'string') return 'META';
    return null;
  }

  /** Registration binding + expiry + backend status. expected = { handoffId, reviewVersion }. */
  function checkBinding(s, expected, now) {
    if (!expected || s.handoffId !== expected.handoffId) return 'HANDOFF_MISMATCH';
    if (s.sourceReviewVersion !== expected.reviewVersion) return 'REVIEW_VERSION_MISMATCH';
    if (s.status === 'STALE_HANDOFF') return 'STALE_HANDOFF';
    if (s.status === 'EXPIRED' || Date.parse(s.expiresAt) <= now) return 'EXPIRED';
    return null;
  }

  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }

  async function verifyIntegrity(s, key, subtle) {
    if (!subtle || typeof key !== 'string' || !key) return false;
    var enc = new TextEncoder();
    var k = await subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    var mac = hex(await subtle.sign('HMAC', k, enc.encode(integrityPayload(s))));
    if (mac.length !== s.integrity.length) return false;
    var diff = 0;
    for (var i = 0; i < mac.length; i++) diff |= mac.charCodeAt(i) ^ s.integrity.charCodeAt(i);
    return diff === 0;
  }

  /** Backend HTTP outcome → refusal reason (unknown handoff / rotated token = another handoff now owns the session). */
  function reasonForHttp(code) {
    if (code === 'IRCTC_HANDOFF_NOT_FOUND' || code === 'HTTP_404') return 'UNKNOWN_HANDOFF';
    if (code === 'BRIDGE_TOKEN_INVALID' || code === 'HTTP_401') return 'SESSION_MISMATCH';
    return null;
  }

  /** Every check; terminal outcome statuses (COMPLETED / FAILED / UNKNOWN / STOPPED) pass through for display only. */
  async function guardSnapshot(s, expected, key, now, subtle) {
    var bad = validateSnapshotSchema(s);
    if (bad) return { ok: false, code: 'STALE_IRCTC_HANDOFF', reason: 'SCHEMA_INVALID', detail: bad };
    var b = checkBinding(s, expected, now);
    if (b) return { ok: false, code: 'STALE_IRCTC_HANDOFF', reason: b };
    if (!(await verifyIntegrity(s, key, subtle))) return { ok: false, code: 'STALE_IRCTC_HANDOFF', reason: 'INTEGRITY_FAILED' };
    return { ok: true, snapshot: s };
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION, APPROVED_HOST: APPROVED_HOST, INTEGRITY_FIELDS: INTEGRITY_FIELDS,
    isApprovedIrctcPage: isApprovedIrctcPage, canonicalJson: canonicalJson, integrityPayload: integrityPayload,
    validateSnapshotSchema: validateSnapshotSchema, checkBinding: checkBinding, verifyIntegrity: verifyIntegrity,
    reasonForHttp: reasonForHttp, guardSnapshot: guardSnapshot
  };
});
