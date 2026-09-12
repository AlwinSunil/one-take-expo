package dev.onetake.npu;

import android.media.*;
import android.os.SystemClock;
import java.io.*;
import java.nio.*;
import java.util.Arrays;
import java.util.function.Consumer;

/** A bounded, timestamp-aware comparison for the padded synthetic 12s/8s fixture. */
final class MediaAudioProbe {
  static final class Pcm {
    float[] samples; int rate;
    Pcm(float[] samples, int rate) { this.samples=samples; this.rate=rate; }
  }
  static void inspect(File dir, Consumer<String> log) throws Exception {
    Pcm source=decode(new File(dir,"media-source.mp4"),log);
    Pcm output=decode(new File(dir,"media-export.mp4"),log);
    if(source.rate!=output.rate) throw new IOException("Different sample rates require explicit resampling");
    int rate=source.rate;
    if(source.samples.length<11.9*rate || output.samples.length<7.9*rate) throw new IOException("Unexpected truncated fixture duration");
    log.accept("scope=decoded padded synthetic speech; not perceptual human lip sync; cuts=[0,4),[8,12)");
    boolean pass=true;
    for(int segment=0;segment<2;segment++) {
      double sourceStart=segment*8,outputStart=segment*4;
      int[] voiced=voiceBounds(source,sourceStart,4);
      int[] exported=voiceBounds(output,outputStart,4);
      if(voiced==null||exported==null) throw new IOException("No voiced phrase in segment "+segment);
      double first=voiced[0]/(double)rate,last=voiced[1]/(double)rate;
      double startError=(exported[0]-voiced[0])/(double)rate-(outputStart-sourceStart);
      double endError=(exported[1]-voiced[1])/(double)rate-(outputStart-sourceStart);
      log.accept("segment="+segment+" source_voice_s="+first+","+last+" output_voice_s="+exported[0]/(double)rate+","+exported[1]/(double)rate+" onset_error_ms="+startError*1000+" offset_error_ms="+endError*1000);
      pass &= Math.abs(startError)<0.1 && Math.abs(endError)<0.1;
      double width=Math.min(0.35,(last-first)/2);
      if(width<0.12) throw new IOException("Phrase too short for boundary comparison");
      pass &= correlate(source,output,first,outputStart+(first-sourceStart),width,"segment"+segment+"_first_voice",log);
      pass &= correlate(source,output,last-width,outputStart+(last-width-sourceStart),width,"segment"+segment+"_last_voice",log);
    }
    double joinRms=rms(output.samples,(int)(3.85*rate),(int)(4.35*rate));
    double sourceEndRms=rms(source.samples,(int)(3.85*rate),4*rate);
    double sourceNextRms=rms(source.samples,8*rate,(int)(8.35*rate));
    log.accept("join_output_rms="+joinRms+" source_pre_cut_rms="+sourceEndRms+" source_post_cut_rms="+sourceNextRms);
    // The fixture has deliberate silence around its cut, so a loud seam is a regression.
    pass &= joinRms<Math.max(0.005,Math.max(sourceEndRms,sourceNextRms)*3);
    log.accept("PCM_FIXTURE_RESULT="+(pass?"PASS":"FAIL")+" gates=voice_onset_offset_within100ms,each_boundary_correlation>=0.8,each_lag_within100ms,quiet_join");
  }
  static int[] voiceBounds(Pcm pcm,double start,double duration) {
    int a=(int)(start*pcm.rate),b=Math.min(pcm.samples.length,(int)((start+duration)*pcm.rate));
    int block=Math.max(1,pcm.rate/100); double peak=0;
    for(int i=a;i+block<=b;i+=block) peak=Math.max(peak,rms(pcm.samples,i,i+block));
    double threshold=Math.max(.001,peak*.06);int first=-1,last=-1;
    for(int i=a;i+block<=b;i+=block) if(rms(pcm.samples,i,i+block)>=threshold){if(first<0)first=i;last=i+block;}
    return first<0?null:new int[]{first,last};
  }
  static boolean correlate(Pcm source,Pcm output,double sourceTime,double outputTime,double seconds,String label,Consumer<String> log) {
    int a=(int)Math.round(sourceTime*source.rate),b=(int)Math.round(outputTime*source.rate),length=(int)(seconds*source.rate),maxShift=(int)(.15*source.rate);
    double best=-2;int shiftBest=0;
    for(int shift=-maxShift;shift<=maxShift;shift+=2) {
      if(a<0||a+length>source.samples.length||b+shift<0||b+shift+length>output.samples.length)continue;
      double sx=0,sy=0,xx=0,yy=0,xy=0;int n=0;
      for(int i=0;i<length;i+=3){double x=source.samples[a+i],y=output.samples[b+shift+i];sx+=x;sy+=y;xx+=x*x;yy+=y*y;xy+=x*y;n++;}
      double denom=Math.sqrt(Math.max(1e-20,(xx-sx*sx/n)*(yy-sy*sy/n)));
      double correlation=(xy-sx*sy/n)/denom;
      if(correlation>best){best=correlation;shiftBest=shift;}
    }
    double lagMs=shiftBest*1000.0/source.rate;
    log.accept(label+" source_s="+sourceTime+" expected_output_s="+outputTime+" duration_s="+seconds+" correlation="+best+" output_lag_ms="+lagMs);
    return best>=.8 && Math.abs(lagMs)<100;
  }
  static double rms(float[] samples,int start,int end){double energy=0;int n=0;for(int i=Math.max(0,start);i<Math.min(end,samples.length);i++){energy+=samples[i]*samples[i];n++;}return Math.sqrt(energy/Math.max(1,n));}
  static Pcm decode(File file,Consumer<String> log) throws Exception {
    MediaExtractor extractor=new MediaExtractor();MediaCodec codec=null;
    try {
      extractor.setDataSource(file.getPath());MediaFormat format=null;
      for(int i=0;i<extractor.getTrackCount();i++){MediaFormat candidate=extractor.getTrackFormat(i);if(candidate.getString(MediaFormat.KEY_MIME).startsWith("audio/")){extractor.selectTrack(i);format=candidate;break;}}
      if(format==null)throw new IOException("No audio: "+file);
      int rate=format.getInteger(MediaFormat.KEY_SAMPLE_RATE),channels=format.getInteger(MediaFormat.KEY_CHANNEL_COUNT),encoding=AudioFormat.ENCODING_PCM_16BIT;
      if(rate<8000||rate>192000)throw new IOException("Unexpected sample rate");
      float[] samples=new float[rate*20];int used=0;boolean inputDone=false,outputDone=false;
      codec=MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME));codec.configure(format,null,null,0);codec.start();
      MediaCodec.BufferInfo info=new MediaCodec.BufferInfo();long deadline=SystemClock.elapsedRealtime()+60000;
      while(!outputDone){
        if(SystemClock.elapsedRealtime()>deadline)throw new IOException("Audio decode timeout");
        if(!inputDone){int index=codec.dequeueInputBuffer(10000);if(index>=0){ByteBuffer in=codec.getInputBuffer(index);in.clear();int size=extractor.readSampleData(in,0);if(size<0){codec.queueInputBuffer(index,0,0,0,MediaCodec.BUFFER_FLAG_END_OF_STREAM);inputDone=true;}else{codec.queueInputBuffer(index,0,size,extractor.getSampleTime(),0);extractor.advance();}}}
        int index=codec.dequeueOutputBuffer(info,10000);
        if(index==MediaCodec.INFO_OUTPUT_FORMAT_CHANGED){MediaFormat out=codec.getOutputFormat();if(rate!=out.getInteger(MediaFormat.KEY_SAMPLE_RATE))throw new IOException("Decoder changed rate");channels=out.getInteger(MediaFormat.KEY_CHANNEL_COUNT);encoding=out.containsKey(MediaFormat.KEY_PCM_ENCODING)?out.getInteger(MediaFormat.KEY_PCM_ENCODING):AudioFormat.ENCODING_PCM_16BIT;log.accept(file.getName()+" decoded="+out);}
        else if(index>=0){
          try {
            if(encoding!=AudioFormat.ENCODING_PCM_16BIT&&encoding!=AudioFormat.ENCODING_PCM_FLOAT)throw new IOException("Unsupported PCM encoding "+encoding);
            ByteBuffer out=codec.getOutputBuffer(index).order(ByteOrder.LITTLE_ENDIAN);out.position(info.offset);out.limit(info.offset+info.size);
            int frameBytes=channels*(encoding==AudioFormat.ENCODING_PCM_FLOAT?4:2),frames=info.size/frameBytes;
            int start=(int)Math.round(info.presentationTimeUs*rate/1e6);
            for(int f=0;f<frames;f++){float sum=0;for(int c=0;c<channels;c++)sum+=encoding==AudioFormat.ENCODING_PCM_FLOAT?out.getFloat():out.getShort()/32768f;int at=start+f;if(at>=samples.length)throw new IOException("Only fixtures <=20s supported");if(at>=0){samples[at]=sum/channels;used=Math.max(used,at+1);}}
            outputDone=(info.flags&MediaCodec.BUFFER_FLAG_END_OF_STREAM)!=0;
          } finally {codec.releaseOutputBuffer(index,false);}
        }
      }
      log.accept(file.getName()+" decoded_timeline_samples="+used+" sample_rate="+rate+" timestamp_origin=container_zero,negative_priming_discarded");
      return new Pcm(Arrays.copyOf(samples,used),rate);
    } finally {if(codec!=null){try{codec.stop();}finally{codec.release();}}extractor.release();}
  }
}
