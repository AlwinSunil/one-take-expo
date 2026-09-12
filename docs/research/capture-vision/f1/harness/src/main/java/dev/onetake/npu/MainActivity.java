package dev.onetake.npu;

import android.app.Activity;
import android.os.Bundle;
import android.os.SystemClock;
import android.system.Os;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.widget.TextView;
import ai.onnxruntime.*;
import java.io.*;
import java.nio.*;
import java.util.*;

public class MainActivity extends Activity {
  private TextView status;
  private PrintWriter report;
  private CaptureProbe capture;
  private void log(String text) {
    android.util.Log.i("OneTakeNpu", text);
    report.println(text); report.flush();
    runOnUiThread(() -> status.append(text + "\n"));
  }
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    status = new TextView(this); status.setTextSize(15); status.setPadding(28,70,28,28);
    status.setText("Isolated NPU probe\n"); setContentView(status);
    new Thread(() -> {
      try {
        boolean inspect=getIntent().getBooleanExtra("inspect",false);
        boolean mediaAudio=getIntent().getBooleanExtra("media_audio",false);
        report = new PrintWriter(new File(getFilesDir(), mediaAudio ? "media-audio-result.txt" : inspect ? "inspect-result.txt" : "result.txt"));
        if(mediaAudio){MediaAudioProbe.inspect(getFilesDir(),this::log);}else if(inspect){AudioSync.inspect(getFilesDir(),this::log);playback();}else runProbe();
      } catch (Throwable error) {
        if (report != null) { log("FAILED " + error); error.printStackTrace(report); report.flush(); }
      } finally { if (capture != null) capture.stop(); if (report != null) report.close(); }
    }, "npu-probe").start();
  }
  private void playback() throws Exception {
    java.util.concurrent.CountDownLatch done=new java.util.concurrent.CountDownLatch(1);
    runOnUiThread(() -> {
      android.widget.VideoView video=new android.widget.VideoView(this);setContentView(video);
      video.setVideoPath(new File(getFilesDir(),"capture.mp4").getPath());
      video.setOnPreparedListener(player -> {log("playback_duration_ms="+player.getDuration());video.start();new android.os.Handler().postDelayed(() -> {log("playback_seek_end_ms="+(video.getDuration()-3000));video.seekTo(video.getDuration()-3000);},4000);});
      video.setOnInfoListener((player,what,extra) -> {log("playback_info="+what+","+extra);return false;});
      video.setOnCompletionListener(player -> {log("playback_complete");done.countDown();});
      video.setOnErrorListener((player,what,extra) -> {log("playback_error="+what+","+extra);done.countDown();return true;});
    });
    if(!done.await(20,java.util.concurrent.TimeUnit.SECONDS))log("playback_timeout");
  }
  private void runProbe() throws Exception {
    if(getIntent().getBooleanExtra("fallback",false)) {
      log("forced_model_initialization_failure; optional vision disabled");
      capture=new CaptureProbe(this,this::log,"fallback");capture.start();
      Thread.sleep(5000);capture.stop();capture=null;
      android.media.MediaMetadataRetriever metadata=new android.media.MediaMetadataRetriever();
      try {metadata.setDataSource(new File(getFilesDir(),"fallback.mp4").getPath());
        log("fallback_duration_ms="+metadata.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION));
        log("fallback_has_video="+metadata.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO));
        log("fallback_has_audio="+metadata.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO));
      }finally{metadata.release();}
      log("FALLBACK_COMPLETE");return;
    }
    String libs = getApplicationInfo().nativeLibraryDir;
    // Android sandbox hides SoC/device discovery; register an EP device, then require the explicit HTP backend.
    Os.setenv("ORT_QNN_ENABLE_CPU_BACKEND", "1", true);
    Os.setenv("ADSP_LIBRARY_PATH", libs + ";/vendor/lib/rfsa/adsp;/vendor/dsp/cdsp;/vendor/dsp", true);
    for (String asset : getAssets().list("")) {
      if (!asset.endsWith(".onnx") && !asset.endsWith(".bin") && !asset.endsWith(".json")) continue;
      try (InputStream in = getAssets().open(asset); OutputStream out = new FileOutputStream(new File(getFilesDir(), asset))) {
        byte[] buffer = new byte[65536]; int n; while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
      }
    }
    log("fingerprint=" + android.os.Build.FINGERPRINT);
    OrtEnvironment env = OrtEnvironment.getEnvironment(OrtLoggingLevel.ORT_LOGGING_LEVEL_VERBOSE);
    log("ORT=" + env.getVersion());
    env.registerExecutionProviderLibrary("QNNExecutionProvider", libs + "/libonnxruntime_providers_qnn.so");
    List<OrtEpDevice> devices = new ArrayList<>();
    for (OrtEpDevice device : env.getEpDevices()) {
      log("device=" + device);
      if (device.getEpName().contains("QNN")) devices.add(device);
    }
    if (devices.isEmpty()) throw new IllegalStateException("QNN exposes no device");
    String imagePath = getIntent().getStringExtra("image_path");
    Bitmap image = imagePath == null ? null : BitmapFactory.decodeFile(imagePath);
    if (imagePath != null && image == null) throw new IOException("Cannot decode supplied image");
    log("input=" + (image == null ? "synthetic negative fixture; no semantic accuracy claim" : imagePath));
    if (getIntent().getBooleanExtra("capture", false)) {
      capture = new CaptureProbe(this, this::log); capture.start();
    }
    for (String name : new String[]{"pose_detector", "pose_landmark_detector"}) {
      int size = name.equals("pose_detector") ? 128 : 256;
      ByteBuffer input = ByteBuffer.allocateDirect(size * size * 3);
      Bitmap resized = image == null ? null : Bitmap.createScaledBitmap(image, size, size, true);
      for (int y=0;y<size;y++) for (int x=0;x<size;x++) {
        int pixel = resized == null ? (((x/16+y/16)%2)*0xFFFFFF) : resized.getPixel(x,y);
        input.put((byte)(pixel>>16)); input.put((byte)(pixel>>8)); input.put((byte)pixel);
      }
      input.rewind();
      try (OrtSession.SessionOptions options = new OrtSession.SessionOptions()) {
        options.setSessionLogLevel(OrtLoggingLevel.ORT_LOGGING_LEVEL_VERBOSE);
        options.addConfigEntry("session.disable_cpu_ep_fallback", "1");
        options.enableProfiling(new File(getFilesDir(), name + "-ort").getPath());
        Map<String,String> provider = new HashMap<>();
        provider.put("backend_path", libs + "/libQnnHtp.so");
        provider.put("profiling_level", "detailed");
        provider.put("profiling_file_path", new File(getFilesDir(),name+"-qnn.csv").getPath());
        options.addExecutionProvider(devices, provider);
        long load = SystemClock.elapsedRealtimeNanos();
        try (OrtSession session = env.createSession(new File(getFilesDir(),name+".onnx").getPath(),options);
             OnnxTensor tensor = OnnxTensor.createTensor(env,input,new long[]{1,size,size,3},OnnxJavaType.UINT8)) {
          log(name+" load_ms="+(SystemClock.elapsedRealtimeNanos()-load)/1e6);
          log("inputs="+session.getInputInfo()+" outputs="+session.getOutputInfo());
          int iterations = capture != null && name.equals("pose_detector") ? 600 : 35;
          long pacedStart = SystemClock.elapsedRealtime();
          for (int i=0;i<iterations;i++) {
            Bitmap sourceFrame=capture==null?image:capture.latest;
            if (capture != null && sourceFrame != null) {
              Bitmap frame=Bitmap.createScaledBitmap(sourceFrame,size,size,true);
              input.clear();
              for(int row=0;row<size;row++)for(int col=0;col<size;col++){int pixel=frame.getPixel(col,row);input.put((byte)(pixel>>16));input.put((byte)(pixel>>8));input.put((byte)pixel);}
              input.rewind();
            }
            long start = SystemClock.elapsedRealtimeNanos();
            try (OrtSession.Result result = session.run(Collections.singletonMap("image",tensor))) {
              double ms=(SystemClock.elapsedRealtimeNanos()-start)/1e6;
              log(name+" iteration="+i+" ms="+ms);
              if(i==iterations-1 && name.equals("pose_detector"))Detection.summarize(result,sourceFrame,new File(getFilesDir(),"detector.png"),this::log);
              if (i==iterations-1) for (Map.Entry<String,OnnxValue> entry:result) {
                ByteBuffer bytes=((OnnxTensor)entry.getValue()).getByteBuffer();
                int maximum=0,minimum=255; ByteBuffer scan=bytes.duplicate();while(scan.hasRemaining()){int value=scan.get()&255;maximum=Math.max(maximum,value);minimum=Math.min(minimum,value);}
                log("output_range "+entry.getKey()+" min="+minimum+" max="+maximum);
                int count=0; StringBuilder values=new StringBuilder();
                while(bytes.hasRemaining() && count++<100) values.append(bytes.get()&255).append(',');
                log("output "+entry.getKey()+"="+values);
              }
            }
            if(capture != null && name.equals("pose_detector")) {
              if(i%25==0)capture.sampleResources();
              long wait=200L*(i+1)-(SystemClock.elapsedRealtime()-pacedStart);
              if(wait>0)Thread.sleep(wait);
            }
          }
          log("profile="+session.endProfiling());
        }
      }
    }
    log("COMPLETE; HTP graph execution with CPU fallback disabled; preprocessing remains CPU");
  }
}
