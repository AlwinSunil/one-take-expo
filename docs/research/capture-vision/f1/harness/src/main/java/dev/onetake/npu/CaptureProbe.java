package dev.onetake.npu;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.ImageFormat;
import android.hardware.camera2.*;
import android.media.*;
import android.os.*;
import android.view.Surface;
import java.io.*;
import java.nio.ByteBuffer;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

final class CaptureProbe {
  volatile Bitmap latest;
  volatile boolean active;
  private CameraDevice camera;
  private CameraCaptureSession session;
  private ImageReader reader;
  private MediaRecorder recorder;
  private AudioRecord audio;
  private HandlerThread cameraThread;
  private Thread audioThread;
  private long frames, pcmSamples, nonzeroSamples;
  private final Activity activity;
  private final Consumer<String> log;
  private final String prefix;
  CaptureProbe(Activity activity, Consumer<String> log) { this(activity,log,"capture"); }
  CaptureProbe(Activity activity, Consumer<String> log, String prefix) { this.activity=activity;this.log=log;this.prefix=prefix; }
  void start() throws Exception {
    cameraThread=new HandlerThread("capture-consumer");cameraThread.start();
    Handler handler=new Handler(cameraThread.getLooper());
    recorder=new MediaRecorder(activity);
    recorder.setAudioSource(MediaRecorder.AudioSource.CAMCORDER);
    recorder.setVideoSource(MediaRecorder.VideoSource.SURFACE);
    recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
    recorder.setOutputFile(new File(activity.getFilesDir(),prefix+".mp4"));
    recorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264);
    recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
    recorder.setVideoSize(1280,720);recorder.setVideoFrameRate(30);recorder.setVideoEncodingBitRate(4000000);
    recorder.setAudioSamplingRate(48000);recorder.setAudioEncodingBitRate(128000);recorder.prepare();
    reader=ImageReader.newInstance(640,480,ImageFormat.YUV_420_888,2);
    reader.setOnImageAvailableListener(r -> {
      try(Image image=r.acquireLatestImage()) {
        if(image==null)return;
        frames++;
        if(frames%6!=0)return;
        Image.Plane y=image.getPlanes()[0],u=image.getPlanes()[1],v=image.getPlanes()[2];
        ByteBuffer yb=y.getBuffer(),ub=u.getBuffer(),vb=v.getBuffer();
        int w=image.getWidth(),h=image.getHeight();int[] pixels=new int[w*h];
        for(int row=0;row<h;row++)for(int col=0;col<w;col++){
          int yy=yb.get(row*y.getRowStride()+col*y.getPixelStride())&255;
          int uu=(ub.get(row/2*u.getRowStride()+col/2*u.getPixelStride())&255)-128;
          int vv=(vb.get(row/2*v.getRowStride()+col/2*v.getPixelStride())&255)-128;
          int red=clamp((int)(yy+1.402*vv)),green=clamp((int)(yy-.344136*uu-.714136*vv)),blue=clamp((int)(yy+1.772*uu));
          pixels[row*w+col]=0xff000000|(red<<16)|(green<<8)|blue;
        }
        latest=Bitmap.createBitmap(pixels,w,h,Bitmap.Config.ARGB_8888);
        if(frames==6 || frames%1800==0){try(FileOutputStream out=new FileOutputStream(new File(activity.getFilesDir(),"frame-"+frames+".jpg"))){latest.compress(Bitmap.CompressFormat.JPEG,85,out);}}
        if(frames%150==0)log.accept("camera frames="+frames+" timestamp_ns="+image.getTimestamp()+" elapsed_ns="+SystemClock.elapsedRealtimeNanos());
      }catch(Throwable error){log.accept("frame_error="+error);}
    },handler);
    CameraManager manager=(CameraManager)activity.getSystemService(Activity.CAMERA_SERVICE);
    String id=null;
    for(String candidate:manager.getCameraIdList())if(manager.getCameraCharacteristics(candidate).get(CameraCharacteristics.LENS_FACING)==CameraCharacteristics.LENS_FACING_BACK){id=candidate;break;}
    if(id==null)throw new IllegalStateException("No back camera");
    CountDownLatch ready=new CountDownLatch(1);
    final Exception[] failure=new Exception[1];
    manager.openCamera(id,new CameraDevice.StateCallback(){
      public void onOpened(CameraDevice device){
        camera=device;
        try{
          List<Surface> outputs=Arrays.asList(recorder.getSurface(),reader.getSurface());
          device.createCaptureSession(outputs,new CameraCaptureSession.StateCallback(){
            public void onConfigured(CameraCaptureSession value){
              session=value;
              try{
                CaptureRequest.Builder request=device.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
                for(Surface surface:outputs)request.addTarget(surface);
                session.setRepeatingRequest(request.build(),null,handler);
                recorder.start();active=true;
                log.accept("recording_start_elapsed_ns="+SystemClock.elapsedRealtimeNanos());
              }catch(Exception e){failure[0]=e;}finally{ready.countDown();}
            }
            public void onConfigureFailed(CameraCaptureSession value){failure[0]=new IllegalStateException("Camera stream combination rejected");ready.countDown();}
          },handler);
        }catch(Exception e){failure[0]=e;ready.countDown();}
      }
      public void onDisconnected(CameraDevice d){failure[0]=new IllegalStateException("Camera disconnected");ready.countDown();}
      public void onError(CameraDevice d,int error){failure[0]=new IllegalStateException("Camera error "+error);ready.countDown();}
    },handler);
    if(!ready.await(15,TimeUnit.SECONDS))throw new IOException("Camera startup timed out");
    if(failure[0]!=null)throw failure[0];
    int buffer=Math.max(3200,AudioRecord.getMinBufferSize(16000,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT));
    audio=new AudioRecord(MediaRecorder.AudioSource.MIC,16000,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT,buffer);
    audio.startRecording();
    audioThread=new Thread(() -> {
      try(DataOutputStream out=new DataOutputStream(new FileOutputStream(new File(activity.getFilesDir(),prefix.equals("capture")?"consumer.pcm":prefix+".pcm")))){
        short[] chunk=new short[320];long blocks=0;
        while(active){
          int count=audio.read(chunk,0,chunk.length);if(count<0){log.accept("audio_read_error="+count);break;}
          double energy=0;
          for(int i=0;i<count;i++){int x=chunk[i];pcmSamples++;if(x!=0)nonzeroSamples++;energy+=(double)x*x;out.writeByte(x&255);out.writeByte((x>>8)&255);}
          if(++blocks%250==0){
            AudioTimestamp timestamp=new AudioTimestamp();int result=audio.getTimestamp(timestamp,AudioTimestamp.TIMEBASE_MONOTONIC);
            log.accept("audio samples="+pcmSamples+" nonzero="+nonzeroSamples+" rms="+Math.sqrt(energy/Math.max(1,count))+" timestamp_status="+result+" position="+timestamp.framePosition+" ns="+timestamp.nanoTime);
          }
        }
      }catch(Exception e){log.accept("audio_error="+e);}
    },"pcm-consumer");audioThread.start();
  }
  void sampleResources(){
    Debug.MemoryInfo memory=new Debug.MemoryInfo();Debug.getMemoryInfo(memory);
    int thermal=((PowerManager)activity.getSystemService(Activity.POWER_SERVICE)).getCurrentThermalStatus();
    log.accept("resources elapsed_ns="+SystemClock.elapsedRealtimeNanos()+" pss_kb="+memory.getTotalPss()+" thermal_status="+thermal);
  }
  void stop(){
    active=false;
    if(audio!=null){try{audio.stop();if(audioThread!=null)audioThread.join(2000);}catch(Exception e){log.accept("audio_stop_error="+e);}audio.release();}
    try{if(session!=null)session.stopRepeating();if(recorder!=null)recorder.stop();}catch(Exception e){log.accept("recording_stop_error="+e);}
    if(session!=null)session.close();if(camera!=null)camera.close();if(reader!=null)reader.close();if(recorder!=null)recorder.release();
    if(cameraThread!=null)cameraThread.quitSafely();
    log.accept("recording_end_elapsed_ns="+SystemClock.elapsedRealtimeNanos()+" frames="+frames+" pcm_samples="+pcmSamples+" nonzero_samples="+nonzeroSamples);
  }
  private static int clamp(int value){return Math.max(0,Math.min(255,value));}
}
