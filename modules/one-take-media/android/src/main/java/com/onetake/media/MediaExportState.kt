package com.onetake.media

internal object MediaExportState {
  fun cancel(status: MediaExportStatus): MediaExportStatus = when (status) {
    MediaExportStatus.QUEUED, MediaExportStatus.RUNNING -> MediaExportStatus.CANCELLED
    MediaExportStatus.COMPLETED, MediaExportStatus.CANCELLED,
    MediaExportStatus.FAILED, MediaExportStatus.INTERRUPTED -> status
  }

  fun canRetry(status: MediaExportStatus): Boolean = when (status) {
    MediaExportStatus.CANCELLED, MediaExportStatus.FAILED, MediaExportStatus.INTERRUPTED -> true
    MediaExportStatus.QUEUED, MediaExportStatus.RUNNING, MediaExportStatus.COMPLETED -> false
  }
}
