package com.bookkaro.assistant.core

import java.security.MessageDigest
import java.time.Instant
import java.time.OffsetDateTime
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * P40 — Kotlin port of extension/irctc-handoff-guard.js (the P39.3 guard), rule for rule:
 * strict schema allow-list → binding (handoffId + reviewVersion registered by the app) → expiry / backend status →
 * HMAC-SHA256(bridgeToken) over the canonical integrity payload. Verified against the same generated vectors as JS.
 * Any failure → STALE_IRCTC_HANDOFF with the JS reason; nothing is filled from a refused handoff.
 */
object HandoffGuard {
    const val SCHEMA_VERSION = 1L
    val INTEGRITY_FIELDS = listOf("schemaVersion", "handoffId", "sourceReviewVersion", "createdAt", "expiresAt", "mockData", "journey", "train", "travelClass", "quota", "passengers")
    private val TOP_KEYS = listOf("handoffId", "status", "createdAt", "expiresAt", "language", "mockData", "journey", "train", "travelClass", "quota", "passengers",
        "userActions", "notConfirmed", "message", "schemaVersion", "sourceReviewVersion", "integrity")
    val STATUSES = setOf("READY", "LANGUAGE_SELECTION", "LOGIN_REQUIRED", "JOURNEY_PAGE", "TRAIN_LIST", "PASSENGER_PAGE", "READY_FOR_USER_BOOK", "CAPTCHA_REQUIRED",
        "OTP_REQUIRED", "PAYMENT_PAGE", "PAUSED", "SESSION_EXPIRED", "COMPLETED", "BOOKING_FAILED", "BOOKING_STATUS_UNKNOWN", "EXPIRED", "STALE_HANDOFF", "STOPPED")
    val HANDOFF_ID_RE = Regex("^irh_[0-9a-f-]{36}$")
    private val STATION_RE = Regex("^[A-Z0-9]{1,6}$")
    private val INTEGRITY_RE = Regex("^[0-9a-f]{64}$")
    private val DATE_RE = Regex("^(\\d{4})-(\\d{2})-(\\d{2})$")
    private val TRAIN_RE = Regex("^\\d{5}$")
    private val CLASS_RE = Regex("^[0-9A-Z]{2}$")

    data class Expected(val handoffId: String, val reviewVersion: Long)
    data class Result(val ok: Boolean, val code: String? = null, val reason: String? = null, val detail: String? = null, val snapshot: Map<String, Any?>? = null)

    private fun isStr(v: Any?, re: Regex? = null) = v is String && (re == null || re.matches(v))
    private fun isNullStr(v: Any?) = v == null || v is String
    /** JS: typeof number && Math.floor(v) === v && lo <= v <= hi (31.0 counts as an integer). */
    private fun isInt(v: Any?, lo: Long, hi: Long): Boolean = when (v) {
        is Long -> v in lo..hi
        is Double -> v.isFinite() && Math.floor(v) == v && v >= lo && v <= hi
        else -> false
    }
    private fun asLong(v: Any?): Long? = when {
        v is Long -> v
        v is Double && Math.floor(v) == v -> v.toLong()
        else -> null
    }
    private fun onlyKeys(o: Any?, keys: List<String>) = o is Map<*, *> && o.keys.all { it in keys }

    /** Date.parse equivalent for the ISO timestamps the backend writes. */
    fun parseTime(v: Any?): Long? {
        if (v !is String) return null
        return try { Instant.parse(v).toEpochMilli() } catch (e: Exception) {
            try { OffsetDateTime.parse(v).toInstant().toEpochMilli() } catch (e2: Exception) { null }
        }
    }

    private fun station(st: Any?): Boolean {
        if (!onlyKeys(st, listOf("code", "display", "query"))) return false
        st as Map<*, *>
        return isStr(st["code"], STATION_RE) && isNullStr(st["display"]) && isStr(st["query"], STATION_RE) && st["query"] == st["code"]
    }

    /** Strict schema: only the validated handoff contract, nothing else. Returns null when valid, else the JS reason. */
    fun validateSnapshotSchema(s: Any?): String? {
        if (!onlyKeys(s, TOP_KEYS)) return "UNKNOWN_KEYS"
        s as Map<*, *>
        for (k in TOP_KEYS) if (!s.containsKey(k)) return "MISSING_$k"
        val sv = s["schemaVersion"]
        if (!((sv is Long && sv == SCHEMA_VERSION) || (sv is Double && sv == SCHEMA_VERSION.toDouble()))) return "SCHEMA_VERSION"
        if (!isStr(s["handoffId"], HANDOFF_ID_RE)) return "HANDOFF_ID"
        if (s["status"] !in STATUSES) return "STATUS"
        val created = parseTime(s["createdAt"])
        val expires = parseTime(s["expiresAt"])
        if (!isStr(s["createdAt"]) || created == null || !isStr(s["expiresAt"]) || expires == null || expires <= created) return "TIMES"
        if (s["language"] != "en" && s["language"] != "hi") return "LANGUAGE"
        if (s["mockData"] !is Boolean) return "MOCK_FLAG"
        if (!isInt(s["sourceReviewVersion"], 1, 1_000_000)) return "REVIEW_VERSION"
        if (!isStr(s["integrity"], INTEGRITY_RE)) return "INTEGRITY"
        val j = s["journey"]
        if (!onlyKeys(j, listOf("from", "to", "dateIso", "dateIrctc"))) return "JOURNEY"
        j as Map<*, *>
        if (!station(j["from"]) || !station(j["to"]) || (j["from"] as Map<*, *>)["code"] == (j["to"] as Map<*, *>)["code"]) return "JOURNEY"
        val m = DATE_RE.find((j["dateIso"] as? String) ?: "") ?: return "DATE"
        if (j["dateIrctc"] != "${m.groupValues[3]}/${m.groupValues[2]}/${m.groupValues[1]}") return "DATE"
        val t = s["train"]
        if (!onlyKeys(t, listOf("number", "name", "departure", "arrival"))) return "TRAIN"
        t as Map<*, *>
        if (!isStr(t["number"], TRAIN_RE) || !isNullStr(t["name"]) || !isNullStr(t["departure"]) || !isNullStr(t["arrival"])) return "TRAIN"
        val c = s["travelClass"]
        if (!onlyKeys(c, listOf("code", "label"))) return "CLASS"
        c as Map<*, *>
        if (!isStr(c["code"], CLASS_RE) || !isNullStr(c["label"])) return "CLASS"
        val label = c["label"] as String?
        if (!label.isNullOrEmpty() && !label.contains("(" + c["code"] + ")")) return "CLASS"
        val q = s["quota"]
        if (!onlyKeys(q, listOf("code", "label"))) return "QUOTA"
        q as Map<*, *>
        if (q["code"] != "GN" || q["label"] != "GENERAL") return "QUOTA"
        val p = s["passengers"]
        if (p !is List<*> || p.size < 1 || p.size > 6) return "PASSENGERS"
        p.forEachIndexed { idx, x ->
            if (!onlyKeys(x, listOf("index", "name", "age", "gender", "berth", "food"))) return "PASSENGER_KEYS"
            x as Map<*, *>
            val index = asLong(x["index"])
            if (index == null || index != (idx + 1).toLong()) return "PASSENGER_ORDER"
            val name = x["name"]
            if (name !is String || name.isBlank() || name.length > 60 || !isInt(x["age"], 1, 125)) return "PASSENGER_VALUES"
            if (x["gender"] != null && x["gender"] !in listOf("Male", "Female", "Transgender")) return "PASSENGER_GENDER"
            if (!isNullStr(x["berth"]) || !isNullStr(x["food"])) return "PASSENGER_OPTIONS"
        }
        if (s["userActions"] !is List<*> || s["notConfirmed"] !is List<*> || s["message"] !is String) return "META"
        return null
    }

    /** Registration binding + expiry + backend status. */
    fun checkBinding(s: Map<*, *>, expected: Expected?, nowMs: Long): String? {
        if (expected == null || s["handoffId"] != expected.handoffId) return "HANDOFF_MISMATCH"
        if (asLong(s["sourceReviewVersion"]) != expected.reviewVersion) return "REVIEW_VERSION_MISMATCH"
        if (s["status"] == "STALE_HANDOFF") return "STALE_HANDOFF"
        val exp = parseTime(s["expiresAt"])
        if (s["status"] == "EXPIRED" || exp == null || exp <= nowMs) return "EXPIRED"
        return null
    }

    fun integrityPayload(s: Map<*, *>): String {
        val o = LinkedHashMap<String, Any?>()
        for (k in INTEGRITY_FIELDS) o[k] = s[k]
        return Json.canonical(o)
    }

    fun hmacHex(key: String, payload: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return mac.doFinal(payload.toByteArray(Charsets.UTF_8)).joinToString("") { String.format("%02x", it.toInt() and 0xff) }
    }

    /** Constant-time compare of HMAC-SHA256(bridgeToken, canonical payload) with `integrity`. */
    fun verifyIntegrity(s: Map<*, *>, key: String?): Boolean {
        if (key.isNullOrEmpty()) return false
        val integrity = s["integrity"] as? String ?: return false
        val mac = hmacHex(key, integrityPayload(s))
        return mac.length == integrity.length && MessageDigest.isEqual(mac.toByteArray(Charsets.UTF_8), integrity.toByteArray(Charsets.UTF_8))
    }

    /** Backend HTTP outcome → refusal reason (same mapping as JS). */
    fun reasonForHttp(code: String?): String? = when (code) {
        "IRCTC_HANDOFF_NOT_FOUND", "HTTP_404" -> "UNKNOWN_HANDOFF"
        "BRIDGE_TOKEN_INVALID", "HTTP_401" -> "SESSION_MISMATCH"
        else -> null
    }

    /** Every check; terminal outcome statuses pass through (the controller refuses them at registration). */
    @Suppress("UNCHECKED_CAST")
    fun guard(s: Any?, expected: Expected?, key: String?, nowMs: Long): Result {
        validateSnapshotSchema(s)?.let { return Result(false, "STALE_IRCTC_HANDOFF", "SCHEMA_INVALID", it) }
        s as Map<String, Any?>
        checkBinding(s, expected, nowMs)?.let { return Result(false, "STALE_IRCTC_HANDOFF", it) }
        if (!verifyIntegrity(s, key)) return Result(false, "STALE_IRCTC_HANDOFF", "INTEGRITY_FAILED")
        return Result(true, snapshot = s)
    }
}
