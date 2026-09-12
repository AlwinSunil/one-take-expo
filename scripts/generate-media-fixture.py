"""Generate the local synthetic #9 fixture on macOS; does not test app behavior."""
import argparse
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--output', default='/tmp/one-take-media-fixture')
args = parser.parse_args()
folder = Path(args.output)
folder.mkdir(parents=True, exist_ok=True)
for name, phrase in [('first', 'This is the first clean take.'), ('middle', 'Remove this unwanted middle take.'), ('last', 'This is the final clean take.')]:
    subprocess.run(['say', '-v', 'Samantha', '-r', '155', '-o', str(folder / f'{name}.aiff'), phrase], check=True)
filters = (
    '[1:a]adelay=500|500[a1];[2:a]adelay=4500|4500[a2];[3:a]adelay=8500|8500[a3];'
    '[a1][a2][a3]amix=inputs=3:duration=longest:normalize=0,apad,atrim=0:12[a];'
    "[0:v]drawbox=x=25:y=90:w=310:h=160:color=0x2e7869:t=fill:enable='lt(t,4)',"
    "drawbox=x=25:y=90:w=310:h=160:color=0xa33d36:t=fill:enable='between(t,4,8)',"
    "drawbox=x=25:y=90:w=310:h=160:color=0x426bb0:t=fill:enable='gte(t,8)',"
    "drawtext=fontfile=/System/Library/Fonts/Helvetica.ttc:text='SOURCE %{pts\\:hms}':fontsize=23:fontcolor=white:x=20:y=300,"
    "drawtext=fontfile=/System/Library/Fonts/Helvetica.ttc:text='SYNTHETIC RESEARCH':fontsize=18:fontcolor=white:x=22:y=40[v]"
)
subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x153b35:s=360x640:d=12:r=30',
    '-i', str(folder/'first.aiff'), '-i', str(folder/'middle.aiff'), '-i', str(folder/'last.aiff'),
    '-filter_complex', filters, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', str(folder/'media-sample.mp4')], check=True)
print(folder/'media-sample.mp4')
