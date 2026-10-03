"""Generate the TV's phrase clips (public/audio/mira) with Lynx AI, once.

Usage:  LK=<lynx api key> python3 scripts/generate-lola.py public/audio/mira [key ...]
Existing files are skipped; pass keys (e.g. op-1 n-80) to regenerate only those
(delete the old .mp3 first). Requests are spaced out: a fast burst got the Lynx
account suspended for "automated access" once. Needs curl and ffmpeg.
"""
import json, os, subprocess, sys, time
KEY = os.environ['LK']
VOICE = os.environ.get('LYNX_TTS_VOICE', 'lynx_voice_mira_v1')
LANGUAGE = os.environ.get('LYNX_TTS_LANGUAGE', 'uz')
EXPRESSIVENESS = os.environ.get('LYNX_TTS_EXPRESSIVENESS', 'natural')
OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
RAW = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'mira-natural-raw'); os.makedirs(RAW, exist_ok=True)
ONES = ['', 'bir', 'ikki', 'uch', 'to‘rt', 'besh', 'olti', 'yetti', 'sakkiz', 'to‘qqiz']
TENS = ['', 'o‘n', 'yigirma', 'o‘ttiz', 'qirq', 'ellik', 'oltmish', 'yetmish', 'sakson', 'to‘qson']
def words(n):  # 1..99
    return ' '.join(w for w in (TENS[n // 10], ONES[n % 10]) if w)
HUND = ['', 'yuz'] + [ONES[i] + ' yuz' for i in range(2, 10)]
ORD = ['birinchi', 'ikkinchi', 'uchinchi', 'to‘rtinchi', 'beshinchi', 'oltinchi']
LET = {'A': 'A', 'B': 'Be', 'C': 'Se', 'D': 'De', 'E': 'E', 'F': 'Ef', 'G': 'Ge'}
items = {}
for k, v in LET.items(): items['l-' + k] = v
# Keep each destination phrase in one recording. Building it from separate
# ordinal/operator/instruction clips makes the cadence sound robotic.
for i in range(1, 7): items['op-%d' % i] = ORD[i - 1] + ' aperatorga murojaat qiling.'
items['op-7'] = 'valyuta aperatorga murojaat qiling.'
items['recall'] = 'Qayta chaqiruv.'
for h in range(1, 10):
    items['h-%d' % h] = HUND[h]
    items['ht-%d' % h] = HUND[h] + ' raqamli mijoz,'
for n in range(1, 100): items['n-%d' % n] = words(n) + ' raqamli mijoz,'
only = sys.argv[2:]
if only: items = {k: v for k, v in items.items() if k in only}
for key, text in items.items():
    dst = os.path.join(OUT, key + '.mp3')
    if os.path.exists(dst): continue
    raw = os.path.join(RAW, key + '.mp3'); hdr = raw + '.h'
    for attempt in range(3):
        subprocess.run(['curl', '-s', '-m', '90', '-o', raw, '-D', hdr, '-X', 'POST', 'https://api.lynx-ai.uz/v1/audio/speech',
                        '-H', 'Authorization: Bearer ' + KEY, '-H', 'Content-Type: application/json',
                        '-d', json.dumps({'text': text, 'voice': VOICE, 'language': LANGUAGE,
                                          'expressiveness': EXPRESSIVENESS,
                                          'ai_normalize': False, 'enhance': False})])
        h = open(hdr).read()
        if 'audio/mpeg' in h: break
        print('retry', key, open(raw, 'rb').read()[:200]); time.sleep(3)
    else:
        sys.exit('failed ' + key)
    used = [l.split(':', 1)[1].strip() for l in h.splitlines() if l.lower().startswith('x-lynx-quota-used')]
    # trim leading/trailing silence so pieces join tightly; small mono MP3
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', raw, '-af',
                    'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.03,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.06,areverse,loudnorm=I=-18:TP=-2:LRA=7,afade=t=in:d=0.015,areverse,afade=t=in:d=0.04,areverse',
                    '-ac', '1', '-ar', '44100', '-b:a', '64k', dst], check=True)
    meta = os.path.join(OUT, 'texts.json')
    d = json.load(open(meta)) if os.path.exists(meta) else {}
    d[key] = text; json.dump(d, open(meta, 'w'), ensure_ascii=False, indent=1, sort_keys=True)
    print(key, '|', text, '| quota used', used[0] if used else '?', flush=True)
    if used and int(used[0]) > 580: sys.exit('quota nearly exhausted, stopping')
    time.sleep(6)
