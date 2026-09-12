package com.onetake.media

import androidx.core.content.FileProvider

// A distinct provider class keeps manifest merging from combining unrelated authorities and paths.
class MediaFileProvider : FileProvider()
