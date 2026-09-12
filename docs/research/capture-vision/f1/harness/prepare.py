"""Stage authorized native artifacts locally; build and run commands are separate."""
import hashlib
import json
import pathlib
import shutil
import urllib.request
import zipfile

target = pathlib.Path('/tmp/one-take-npu')
target.mkdir(parents=True, exist_ok=True)
source = pathlib.Path(__file__).resolve().parent
root = source.parents[4]
artifacts = {
    'qnn250.aar': 'https://repo1.maven.org/maven2/com/qualcomm/qti/qnn-runtime/2.50.0/qnn-runtime-2.50.0.aar',
    'ep.aar': 'https://repo1.maven.org/maven2/com/qualcomm/qti/onnxruntime-android-qnn/2.3.0/onnxruntime-android-qnn-2.3.0.aar',
    'ort.aar': 'https://repo1.maven.org/maven2/com/microsoft/onnxruntime/onnxruntime-android/1.27.0/onnxruntime-android-1.27.0.aar',
    'pose.zip': 'https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/models/mediapipe_pose/releases/v0.62.2/mediapipe_pose-precompiled_qnn_onnx-w8a8-qualcomm_snapdragon_8_elite_gen5_for_galaxy.zip',
    'pose-photo.jpg': 'https://upload.wikimedia.org/wikipedia/commons/8/88/Yoga_Warrior_I.jpg',
}
manifest = {}
expected = json.loads((source.parent / 'evidence/artifacts.json').read_text())
for filename, url in artifacts.items():
    path = target / filename
    if not path.exists():
        urllib.request.urlretrieve(url, path)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != expected[filename]['sha256']:
        raise RuntimeError(f'{path} does not match the measured artifact hash; preserve it separately and fetch the pinned URL again')
    manifest[filename] = dict(url=url, bytes=path.stat().st_size, sha256=digest)
(target / 'artifacts.json').write_text(json.dumps(manifest, indent=2) + '\n')
shutil.copytree(source / 'src', target / 'src', dirs_exist_ok=True)
shutil.copy2(root / 'docs/research/review-export/f3/harness/MediaAudioProbe.java', target / 'src/main/java/dev/onetake/npu/MediaAudioProbe.java')
assets = target / 'src/main/assets'
assets.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(target / 'pose.zip') as archive:
    for item in archive.infolist():
        if item.is_dir():
            continue
        (assets / pathlib.PurePosixPath(item.filename).name).write_bytes(archive.read(item))
shutil.copy2(root / 'android/gradlew', target / 'gradlew')
shutil.copytree(root / 'android/gradle/wrapper', target / 'gradle/wrapper', dirs_exist_ok=True)
(target / 'settings.gradle').write_text("pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\ndependencyResolutionManagement { repositories { google(); mavenCentral() } }\nrootProject.name='NpuProbe'\n")
(target / 'build.gradle').write_text("plugins { id 'com.android.application' version '8.12.0' }\nandroid { namespace 'dev.onetake.npu'; compileSdk 36; defaultConfig { applicationId 'dev.onetake.npu'; minSdk 29; targetSdk 36; versionCode 1; versionName '1'; ndk { abiFilters 'arm64-v8a' } }; packaging { jniLibs { useLegacyPackaging true } } }\ndependencies { implementation files('ort.aar', 'ep.aar', 'qnn250.aar') }\n")
(target / 'gradle.properties').write_text('org.gradle.jvmargs=-Xmx4g\norg.gradle.workers.max=2\n')
(target / 'local.properties').write_text(f'sdk.dir={pathlib.Path.home()}/Library/Android/sdk\n')
print(f'Staged {target}. No build, device installation or inference was run.')
