package com.glidecomp.shareintake

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import expo.modules.core.interfaces.ReactActivityLifecycleListener

/**
 * Turns a Share of a file into an "open" of it, so the app has one way in for
 * a tracklog on both platforms (mobile/src/submit/incoming.ts).
 *
 * React Native's Linking only reports an intent's data, and only for
 * ACTION_VIEW; a Share (ACTION_SEND) carries its file in EXTRA_STREAM instead,
 * so without this an IGC shared from an instrument's app would open the app
 * and go nowhere. Rewriting the intent in place — before React Native reads it
 * at launch, and before it handles a new one — makes the shared file arrive as
 * the URL `+native-intent.tsx` already handles. The read permission the
 * sharing app granted travels with the intent, untouched.
 */
class ShareIntakeListener : ReactActivityLifecycleListener {
  override fun onCreate(activity: Activity?, savedInstanceState: Bundle?) {
    activity?.intent?.let(::asView)
  }

  override fun onNewIntent(intent: Intent?): Boolean {
    intent?.let(::asView)
    // Not handled here: React Native still has to deliver it.
    return false
  }
}

internal fun asView(intent: Intent) {
  if (intent.action != Intent.ACTION_SEND) return
  val stream: Uri = streamOf(intent) ?: return
  intent.action = Intent.ACTION_VIEW
  // setData would clear the type; keep it.
  intent.setDataAndType(stream, intent.type)
}

private fun streamOf(intent: Intent): Uri? =
  if (Build.VERSION.SDK_INT >= 33) {
    intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
  } else {
    @Suppress("DEPRECATION")
    intent.getParcelableExtra(Intent.EXTRA_STREAM)
  }
