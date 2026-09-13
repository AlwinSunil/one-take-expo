# Moonshine's Java facade is called directly by OneTakeCaptionsModule.

# GenieX JNI resolves Kotlin wrappers and bean fields by their original names.
-keep class com.geniex.sdk.** { *; }
