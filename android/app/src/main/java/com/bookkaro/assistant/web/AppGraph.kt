package com.bookkaro.assistant.web

import com.bookkaro.assistant.BuildConfig
import com.bookkaro.assistant.core.HandoffController
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** P40 — process-wide singletons. The handoff lives only in this process's memory (process death = no replay). */
object AppGraph {
    const val VERSION = "android-" + BuildConfig.VERSION_NAME
    val allowMock: Boolean = BuildConfig.ALLOW_MOCK_IRCTC
    val controller: HandoffController by lazy { HandoffController(HttpBackend(BuildConfig.BOOKKARO_ORIGIN), allowMock = allowMock) }
    val io: ExecutorService by lazy { Executors.newSingleThreadExecutor { r -> Thread(r, "bookkaro-handoff").apply { isDaemon = true } } }
}
