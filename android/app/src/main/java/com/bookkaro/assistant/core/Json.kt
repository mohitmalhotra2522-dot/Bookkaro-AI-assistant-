package com.bookkaro.assistant.core

import java.math.BigDecimal

/**
 * P40 — minimal, strict JSON (no dependency). Objects → LinkedHashMap<String, Any?>, arrays → List, integers → Long,
 * other numbers → Double. [canonical] reproduces the extension's canonicalJson (JSON.stringify escaping, keys sorted by
 * UTF-16 code units) so the HMAC payload is byte-identical to the JS / backend one.
 */
object Json {
    class ParseException(msg: String) : Exception(msg)

    fun parse(text: String): Any? {
        val p = Parser(text)
        p.ws()
        val v = p.value()
        p.ws()
        if (p.i != text.length) throw ParseException("trailing data")
        return v
    }

    private class Parser(val s: String) {
        var i = 0

        fun ws() {
            while (i < s.length && (s[i] == ' ' || s[i] == '\n' || s[i] == '\r' || s[i] == '\t')) i++
        }

        fun value(): Any? {
            if (i >= s.length) throw ParseException("eof")
            return when (val c = s[i]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> str()
                't' -> lit("true", true)
                'f' -> lit("false", false)
                'n' -> lit("null", null)
                else -> if (c == '-' || c in '0'..'9') num() else throw ParseException("unexpected '$c'")
            }
        }

        fun lit(w: String, v: Any?): Any? {
            if (!s.startsWith(w, i)) throw ParseException("bad literal")
            i += w.length
            return v
        }

        fun obj(): Map<String, Any?> {
            val m = LinkedHashMap<String, Any?>()
            i++
            ws()
            if (i < s.length && s[i] == '}') { i++; return m }
            while (true) {
                ws()
                if (i >= s.length || s[i] != '"') throw ParseException("key expected")
                val k = str()
                ws()
                if (i >= s.length || s[i] != ':') throw ParseException("':' expected")
                i++
                ws()
                m[k] = value()
                ws()
                if (i >= s.length) throw ParseException("eof in object")
                if (s[i] == ',') { i++; continue }
                if (s[i] == '}') { i++; return m }
                throw ParseException("',' or '}' expected")
            }
        }

        fun arr(): List<Any?> {
            val a = ArrayList<Any?>()
            i++
            ws()
            if (i < s.length && s[i] == ']') { i++; return a }
            while (true) {
                ws()
                a.add(value())
                ws()
                if (i >= s.length) throw ParseException("eof in array")
                if (s[i] == ',') { i++; continue }
                if (s[i] == ']') { i++; return a }
                throw ParseException("',' or ']' expected")
            }
        }

        fun str(): String {
            val sb = StringBuilder()
            i++
            while (i < s.length) {
                val c = s[i++]
                if (c == '"') return sb.toString()
                if (c == '\\') {
                    if (i >= s.length) throw ParseException("eof in escape")
                    when (val e = s[i++]) {
                        '"' -> sb.append('"')
                        '\\' -> sb.append('\\')
                        '/' -> sb.append('/')
                        'b' -> sb.append('\b')
                        'f' -> sb.append('\u000C')
                        'n' -> sb.append('\n')
                        'r' -> sb.append('\r')
                        't' -> sb.append('\t')
                        'u' -> {
                            if (i + 4 > s.length) throw ParseException("bad \\u")
                            sb.append(s.substring(i, i + 4).toInt(16).toChar())
                            i += 4
                        }
                        else -> throw ParseException("bad escape '$e'")
                    }
                } else {
                    if (c < ' ') throw ParseException("control char in string")
                    sb.append(c)
                }
            }
            throw ParseException("eof in string")
        }

        fun num(): Any {
            val st = i
            if (s[i] == '-') i++
            while (i < s.length && s[i] in '0'..'9') i++
            var frac = false
            if (i < s.length && s[i] == '.') {
                frac = true
                i++
                while (i < s.length && s[i] in '0'..'9') i++
            }
            if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
                frac = true
                i++
                if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
                while (i < s.length && s[i] in '0'..'9') i++
            }
            val t = s.substring(st, i)
            if (t == "-" || t.isEmpty()) throw ParseException("bad number")
            if (!frac) t.toLongOrNull()?.let { return it }
            return t.toDouble()
        }
    }

    /** JSON.stringify string escaping (lowercase \u00xx; lone surrogates escaped, pairs kept). */
    fun quote(v: String): String {
        val sb = StringBuilder("\"")
        var k = 0
        while (k < v.length) {
            val c = v[k]
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\b' -> sb.append("\\b")
                c == '\u000C' -> sb.append("\\f")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c < ' ' -> sb.append("\\u").append(String.format("%04x", c.code))
                Character.isHighSurrogate(c) && k + 1 < v.length && Character.isLowSurrogate(v[k + 1]) -> { sb.append(c).append(v[k + 1]); k++ }
                Character.isSurrogate(c) -> sb.append("\\u").append(String.format("%04x", c.code))
                else -> sb.append(c)
            }
            k++
        }
        return sb.append('"').toString()
    }

    /** Numbers like JS: integral values (incl. 31.0) without a fraction. */
    fun number(n: Number): String {
        if (n is Long || n is Int || n is Short || n is Byte) return n.toLong().toString()
        val d = n.toDouble()
        if (!d.isFinite()) return "null"
        if (d != Math.rint(d) || Math.abs(d) >= 1e21) return d.toString()
        if (d == 0.0) return "0"
        return BigDecimal(d).toPlainString()
    }

    fun canonical(v: Any?): String = when (v) {
        null -> "null"
        is Boolean -> v.toString()
        is Number -> number(v)
        is String -> quote(v)
        is List<*> -> v.joinToString(",", "[", "]") { canonical(it) }
        is Map<*, *> -> v.keys.map { it.toString() }.sorted().joinToString(",", "{", "}") { k -> quote(k) + ":" + canonical(v[k]) }
        else -> throw IllegalArgumentException("not a JSON value")
    }

    fun write(v: Any?): String = when (v) {
        null -> "null"
        is Boolean -> v.toString()
        is Number -> number(v)
        is String -> quote(v)
        is List<*> -> v.joinToString(",", "[", "]") { write(it) }
        is Map<*, *> -> v.entries.joinToString(",", "{", "}") { (k, x) -> quote(k.toString()) + ":" + write(x) }
        else -> throw IllegalArgumentException("not a JSON value")
    }
}
