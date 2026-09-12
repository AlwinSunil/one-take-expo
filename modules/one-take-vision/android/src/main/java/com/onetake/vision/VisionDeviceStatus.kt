package com.onetake.vision

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.content.ContextCompat

internal enum class VisionThermalStatus(val wireValue: String) {
  NONE("none"),
  LIGHT("light"),
  MODERATE("moderate"),
  SEVERE("severe"),
  CRITICAL("critical"),
  EMERGENCY("emergency"),
  SHUTDOWN("shutdown"),
  UNKNOWN("unknown"),
}

internal data class VisionDeviceStatus(
  val batteryPercent: Int?,
  val charging: Boolean?,
  val batteryState: String,
  val thermalStatus: VisionThermalStatus,
  val thermalSeverity: Int?,
  val cameraAvailable: Boolean,
  val cameraPermissionGranted: Boolean,
  val microphoneAvailable: Boolean,
  val microphonePermissionGranted: Boolean,
  val capturedAtMs: Long,
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "batteryPercent" to batteryPercent,
    "charging" to charging,
    "batteryState" to batteryState,
    "thermalStatus" to thermalStatus.wireValue,
    "thermalSeverity" to thermalSeverity,
    "cameraAvailable" to cameraAvailable,
    "cameraPermissionGranted" to cameraPermissionGranted,
    "microphoneAvailable" to microphoneAvailable,
    "microphonePermissionGranted" to microphonePermissionGranted,
    "capturedAtMs" to capturedAtMs,
  )
}

internal object VisionDeviceStatusReader {
  fun read(context: Context): VisionDeviceStatus {
    val batteryIntent = runCatching {
      context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    }.getOrNull()
    val batteryManager = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
    val capacity = batteryManager
      ?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
      ?.takeIf { it in 0..100 }
    val status = batteryIntent?.getIntExtra(
      BatteryManager.EXTRA_STATUS,
      BatteryManager.BATTERY_STATUS_UNKNOWN,
    ) ?: BatteryManager.BATTERY_STATUS_UNKNOWN
    val charging = when (status) {
      BatteryManager.BATTERY_STATUS_CHARGING,
      BatteryManager.BATTERY_STATUS_FULL -> true
      BatteryManager.BATTERY_STATUS_DISCHARGING,
      BatteryManager.BATTERY_STATUS_NOT_CHARGING -> false
      else -> null
    }
    val batteryState = when (status) {
      BatteryManager.BATTERY_STATUS_CHARGING -> "charging"
      BatteryManager.BATTERY_STATUS_FULL -> "full"
      BatteryManager.BATTERY_STATUS_DISCHARGING,
      BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "discharging"
      else -> "unknown"
    }

    val thermalSeverity = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      (context.getSystemService(Context.POWER_SERVICE) as? PowerManager)?.currentThermalStatus
    } else {
      null
    }

    val packageManager = context.packageManager
    return VisionDeviceStatus(
      batteryPercent = capacity,
      charging = charging,
      batteryState = batteryState,
      thermalStatus = thermalStatusFor(thermalSeverity),
      thermalSeverity = thermalSeverity,
      cameraAvailable = packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY),
      cameraPermissionGranted = hasPermission(context, Manifest.permission.CAMERA),
      microphoneAvailable = packageManager.hasSystemFeature(PackageManager.FEATURE_MICROPHONE),
      microphonePermissionGranted = hasPermission(context, Manifest.permission.RECORD_AUDIO),
      capturedAtMs = SystemClock.elapsedRealtime(),
    )
  }

  fun thermalStatus(context: Context): VisionThermalStatus {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return VisionThermalStatus.UNKNOWN
    val severity = (context.getSystemService(Context.POWER_SERVICE) as? PowerManager)
      ?.currentThermalStatus
    return thermalStatusFor(severity)
  }

  /**
   * Vision is optional work. Warm devices keep recording while analysis slows
   * down; critical thermal pressure disables only this module's analyzer.
   */
  fun intervalMs(status: VisionThermalStatus): Long = when (status) {
    VisionThermalStatus.NONE -> 200L
    VisionThermalStatus.LIGHT -> 300L
    VisionThermalStatus.MODERATE -> 500L
    VisionThermalStatus.SEVERE -> 800L
    VisionThermalStatus.CRITICAL,
    VisionThermalStatus.EMERGENCY,
    VisionThermalStatus.SHUTDOWN -> 1_000L
    VisionThermalStatus.UNKNOWN -> 300L
  }

  fun isCritical(status: VisionThermalStatus): Boolean = status == VisionThermalStatus.CRITICAL
    || status == VisionThermalStatus.EMERGENCY
    || status == VisionThermalStatus.SHUTDOWN

  private fun hasPermission(context: Context, permission: String): Boolean =
    ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

  private fun thermalStatusFor(severity: Int?): VisionThermalStatus = when (severity) {
    null -> VisionThermalStatus.UNKNOWN
    0 -> VisionThermalStatus.NONE
    1 -> VisionThermalStatus.LIGHT
    2 -> VisionThermalStatus.MODERATE
    3 -> VisionThermalStatus.SEVERE
    4 -> VisionThermalStatus.CRITICAL
    5 -> VisionThermalStatus.EMERGENCY
    6 -> VisionThermalStatus.SHUTDOWN
    else -> VisionThermalStatus.UNKNOWN
  }
}
