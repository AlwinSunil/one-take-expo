package dev.onetake.npu;

import ai.onnxruntime.*;
import android.graphics.*;
import java.io.*;
import java.nio.ByteBuffer;
import java.util.function.Consumer;

final class Detection {
  static void summarize(OrtSession.Result result, Bitmap image, File output, Consumer<String> log) throws Exception {
    double best=-1;int bestGroup=0,bestIndex=0;
    for(int group=1;group<=2;group++){
      ByteBuffer scores=((OnnxTensor)result.get("box_scores_"+group).get()).getByteBuffer();
      double scale=group==1?5.552783966064453:4.833410263061523;
      int zero=group==1?255:254;
      for(int i=0;scores.hasRemaining();i++){
        double score=1/(1+Math.exp(-((scores.get()&255)-zero)*scale));
        if(score>best){best=score;bestGroup=group;bestIndex=i;}
      }
    }
    log.accept("person_score="+best+" group="+bestGroup+" anchor="+bestIndex+" threshold=0.75");
    if(best<.75){log.accept("person_detection=none");return;}
    int grid=bestGroup==1?16:8,anchors=bestGroup==1?2:6,cell=bestIndex/anchors;
    double anchorX=((cell%grid)+.5)/grid,anchorY=((cell/grid)+.5)/grid;
    ByteBuffer coords=((OnnxTensor)result.get("box_coords_"+bestGroup).get()).getByteBuffer();
    double scale=bestGroup==1?.7927474975585938:1.2209054231643677;
    int zero=bestGroup==1?89:99;
    double[] box=new double[12];for(int i=0;i<12;i++)box[i]=((coords.get(bestIndex*12+i)&255)-zero)*scale;
    double cx=box[0]+128*anchorX,cy=box[1]+128*anchorY;
    double left=(cx-box[2]/2)/128,top=(cy-box[3]/2)/128,right=(cx+box[2]/2)/128,bottom=(cy+box[3]/2)/128;
    log.accept("detector_box_normalized="+left+","+top+","+right+","+bottom+"; localization candidate, not full-body framing acceptance");
    if(image!=null){
      Bitmap annotated=image.copy(Bitmap.Config.ARGB_8888,true);Canvas canvas=new Canvas(annotated);Paint paint=new Paint();paint.setColor(Color.GREEN);paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(Math.max(2,image.getWidth()/150f));
      canvas.drawRect((float)left*image.getWidth(),(float)top*image.getHeight(),(float)right*image.getWidth(),(float)bottom*image.getHeight(),paint);
      try(FileOutputStream stream=new FileOutputStream(output)){annotated.compress(Bitmap.CompressFormat.PNG,100,stream);}
      log.accept("annotated="+output.getName());
    }
  }
}
