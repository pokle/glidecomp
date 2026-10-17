package com.glidecomp.shareintake

import android.net.Uri
import android.provider.OpenableColumns
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The name a content URI's provider gives its file ("task3-flight.igc"). A
 * picked or shared file arrives as `content://…/document/msf:1000000019`,
 * whose last segment means nothing to a pilot checking they chose the right
 * flight, and expo-file-system's `name` reads only the URI.
 */
class ShareIntakeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ShareIntake")

    Function("displayName") { uri: String ->
      val context = appContext.reactContext ?: return@Function null
      try {
        context.contentResolver
          .query(Uri.parse(uri), arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
          ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
      } catch (e: Exception) {
        null
      }
    }
  }
}
