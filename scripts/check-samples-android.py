import argparse, subprocess, xml.etree.ElementTree as ET, re, json
from pathlib import Path

parser = argparse.ArgumentParser(description='Check sample sessions through a connected Android device UI. Begin on app Home.')
parser.add_argument('--serial', required=True)
parser.add_argument('--adb', default='adb')
parser.add_argument('--output', default='/tmp/one-take-samples')
args = parser.parse_args()
ADB, SERIAL, OUT = args.adb, args.serial, Path(args.output)
OUT.mkdir(parents=True, exist_ok=True)

def adb(*args):
    return subprocess.check_output([ADB, '-s', SERIAL, *args])

def nodes():
    adb('shell', 'uiautomator', 'dump', '/sdcard/one-take-ui.xml')
    return ET.fromstring(adb('shell', 'cat', '/sdcard/one-take-ui.xml'))

def label(n):
    return n.get('text', '') or n.get('content-desc', '')

def swipe(up=True):
    size = adb('shell', 'wm', 'size').decode().strip().splitlines()[-1]
    width, height = map(int, re.search(r'(\d+)x(\d+)', size).groups())
    start, end = (int(height * .8), int(height * .32)) if up else (int(height * .32), int(height * .8))
    adb('shell', 'input', 'swipe', str(width//2), str(start), str(width//2), str(end), '300')

def click(text):
    for _ in range(9):
        root = nodes()
        for n in root.iter('node'):
            if label(n) == text or (n.get('clickable') == 'true' and text in label(n)):
                x1,y1,x2,y2 = map(int, re.findall(r'\d+', n.get('bounds')))
                if y2 > y1 and y1 > 0:
                    adb('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2))
                    return
        swipe()
    raise AssertionError('Control not found: '+text)

def assert_text(text):
    root = nodes()
    assert any(text in label(n) for n in root.iter('node')), text

def shot(name):
    (OUT / (name+'.png')).write_bytes(adb('exec-out', 'screencap', '-p'))

def back():
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')

def main():
    checks=[]
    assert_text('Shoot it once.')
    click('Open development sample sessions')
    for title, expected, name in [
        ('Clean read', 'All spoken lines covered', 'clean'),
        ('Flub & re-read', 'All spoken lines covered', 'reread'),
        ('Pending analysis', 'Still checking', 'pending'),
        ('Missing recording', 'Recording unavailable', 'missing-media'),
        ('Action cue', 'Action needs confirmation', 'action-cue'),
        ('Off-frame signal', 'Check the framing', 'off-frame'),
        ('Export failure', 'Export didn’t finish', 'failure'),
    ]:
        click(title); assert_text(expected); shot(name)
        if name == 'action-cue':
            click('Confirm action in sample'); click('Undo confirmation');
            swipe(up=False)
            assert_text('Action needs confirmation')
            checks.append('Required action confirmation and undo')
        if name == 'pending':
            click('Replay completed analysis'); assert_text('All spoken lines covered')
            checks.append('Pending analysis replay')
        if name == 'failure':
            click('Replay export-ready state')
            assert not any('Export didn’t finish' in label(n) for n in nodes().iter('node'))
            click('Reset sample'); assert_text('Export didn’t finish')
            checks.append('Export failure recovery replay and reset')
        back(); assert_text('Every state, on demand.')
        checks.append(name+' open and Android back')
    click('Run handoff checks'); assert_text('19 / 19 checks passed'); shot('checks')
    checks.append('19/19 behavior checks executed in device runtime')
    back(); back(); assert_text('Shoot it once.')
    checks.append('Android back closes runner to Home')
    (OUT/'device-results.json').write_text(json.dumps({'serial':SERIAL,'passed':checks},indent=2)+'\n')
    print(json.dumps({'passed':len(checks),'checks':checks},indent=2))

if __name__ == '__main__':
    main()
