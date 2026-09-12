package dev.onetake.npu;

import android.media.*;
import java.io.*;
import java.nio.*;
import java.util.function.Consumer;

final class AudioSync {
  static void inspect(File directory, Consumer<String> log) throws Exception {
    MediaExtractor extractor=new MediaExtractor();
    extractor.setDataSource(new File(directory,"capture.mp4").getPath());
    MediaFormat format=null;
    for(int i=0;i<extractor.getTrackCount();i++){
      MediaFormat candidate=extractor.getTrackFormat(i);log.accept("track="+candidate);
      if(candidate.getString(MediaFormat.KEY_MIME).startsWith("audio/")){extractor.selectTrack(i);format=candidate;}
    }
    if(format==null)throw new IOException("No recorded audio track");
    MediaCodec codec=MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME));
    codec.configure(format,null,null,0);codec.start();
    ByteArrayOutputStream decoded=new ByteArrayOutputStream();
    MediaCodec.BufferInfo info=new MediaCodec.BufferInfo();boolean inputDone=false,outputDone=false;
    int rate=format.getInteger(MediaFormat.KEY_SAMPLE_RATE),channels=format.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
    try{
      while(!outputDone){
        if(!inputDone){int index=codec.dequeueInputBuffer(10000);if(index>=0){ByteBuffer buffer=codec.getInputBuffer(index);int size=extractor.readSampleData(buffer,0);if(size<0){codec.queueInputBuffer(index,0,0,0,MediaCodec.BUFFER_FLAG_END_OF_STREAM);inputDone=true;}else{codec.queueInputBuffer(index,0,size,extractor.getSampleTime(),0);extractor.advance();}}}
        int index=codec.dequeueOutputBuffer(info,10000);
        if(index==MediaCodec.INFO_OUTPUT_FORMAT_CHANGED){MediaFormat out=codec.getOutputFormat();rate=out.getInteger(MediaFormat.KEY_SAMPLE_RATE);channels=out.getInteger(MediaFormat.KEY_CHANNEL_COUNT);log.accept("decoded_format="+out);}
        else if(index>=0){ByteBuffer buffer=codec.getOutputBuffer(index);byte[] bytes=new byte[info.size];buffer.position(info.offset);buffer.get(bytes);decoded.write(bytes);outputDone=(info.flags&MediaCodec.BUFFER_FLAG_END_OF_STREAM)!=0;codec.releaseOutputBuffer(index,false);}
      }
    }finally{codec.stop();codec.release();extractor.release();}
    byte[] pcm=decoded.toByteArray();
    if(rate%16000!=0)throw new IOException("Unsupported comparison sample rate "+rate);
    int step=rate/16000;
    short[] video=new short[pcm.length/(2*channels*step)];
    for(int i=0;i<video.length;i++){int offset=i*step*channels*2;video[i]=(short)((pcm[offset]&255)|(pcm[offset+1]<<8));}
    byte[] raw=java.nio.file.Files.readAllBytes(new File(directory,"consumer.pcm").toPath());
    short[] consumer=new short[raw.length/2];for(int i=0;i<consumer.length;i++)consumer[i]=(short)((raw[2*i]&255)|(raw[2*i+1]<<8));
    log.accept("audio_compare video_samples16k="+video.length+" consumer_samples="+consumer.length);
    correlate(video,consumer,16000*2,log);
    correlate(video,consumer,Math.min(video.length,consumer.length)-16000*3,log);
  }
  private static void correlate(short[] video,short[] consumer,int position,Consumer<String> log){
    double best=-2;int bestShift=0;double chosenRms=0;
    for(int shift=-8000;shift<=8000;shift+=4){
      double xy=0,xx=0,yy=0,sx=0,sy=0;int n=0;
      for(int i=0;i<8000;i+=8){int a=position+i,b=a+shift;if(a<0||a>=consumer.length||b<0||b>=video.length)continue;double x=consumer[a],y=video[b];sx+=x;sy+=y;xx+=x*x;yy+=y*y;xy+=x*y;n++;}
      if(n<900)continue;
      double varianceX=xx-sx*sx/n,varianceY=yy-sy*sy/n;
      double corr=(xy-sx*sy/n)/Math.sqrt(Math.max(1,varianceX*varianceY));
      if(corr>best){best=corr;bestShift=shift;chosenRms=Math.sqrt(yy/n);}
    }
    log.accept("audio_correlation consumer_s="+position/16000.0+" video_minus_consumer_ms="+bestShift/16.0+" correlation="+best+" video_rms="+chosenRms);
  }
}
