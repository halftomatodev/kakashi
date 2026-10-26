r"""자르기\<캐릭터>\ 안의 보이스 모음 파일을 무음 구간에서 대사 단위로 잘라
캐릭터\<캐릭터>\ 에 mp3 + txt 쌍으로 저장한다. 끝난 원본은 자르기\<캐릭터>\완료\ 로 옮긴다."""
import shutil
import sys

import av
import numpy as np

from transcribe import CHAR_DIR, ROOT, add_cuda_dlls, load

SPLIT_DIR = ROOT / '자르기'
DONE_NAME = '완료'
AUDIO_EXT = {'.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.wma'}
RATE = 44100
ASR_RATE = 16000     # Whisper 입력용

SPLIT_GAP = 0.8      # 이만큼(초) 이상 조용하면 다음 대사로 나눈다. 대사가 중간에 잘리면 늘린다
SILENCE_DB = -30     # 가장 큰 소리보다 이만큼(dB) 작으면 무음으로 본다
PAD_START = 0.15     # 대사 앞 여유
PAD_END = 0.25       # 대사 뒤 여유
MIN_CLIP = 0.3       # 이보다 짧은 소리는 잡음으로 보고 버린다
FRAME = 0.02         # 소리 크기를 재는 단위(초)


def read_audio(path, rate=RATE):
    res = av.AudioResampler(format='flt', layout='mono', rate=rate)
    parts = []
    with av.open(str(path)) as f:
        for frame in f.decode(audio=0):
            parts += [r.to_ndarray().reshape(-1) for r in res.resample(frame)]
    parts += [r.to_ndarray().reshape(-1) for r in res.resample(None)]
    return np.concatenate(parts) if parts else np.zeros(0, np.float32)


def write_mp3(path, samples):
    with av.open(str(path), 'w', format='mp3') as out:
        st = out.add_stream('libmp3lame', rate=RATE)
        st.codec_context.layout = 'mono'
        st.codec_context.bit_rate = 192000
        for i in range(0, len(samples), 1152):
            fr = av.AudioFrame.from_ndarray(samples[np.newaxis, i:i + 1152].astype(np.float32), format='fltp', layout='mono')
            fr.sample_rate = RATE
            fr.pts = i
            for p in st.encode(fr):
                out.mux(p)
        for p in st.encode(None):
            out.mux(p)


def find_speech(audio):
    """소리가 나는 구간 [(시작초, 끝초), ...]을 무음 기준으로 찾는다."""
    hop = int(FRAME * RATE)
    n = len(audio) // hop
    if n == 0:
        return []
    rms = np.sqrt(np.mean(audio[:n * hop].reshape(n, hop) ** 2, axis=1))
    loud = rms > np.percentile(rms, 99) * 10 ** (SILENCE_DB / 20)
    runs, start, quiet = [], None, 0
    gap_frames = int(SPLIT_GAP / FRAME)
    for i, on in enumerate(loud):
        if on:
            if start is None:
                start = i
            quiet = 0
        elif start is not None:
            quiet += 1
            if quiet >= gap_frames:
                runs.append((start, i - quiet + 1))
                start, quiet = None, 0
    if start is not None:
        runs.append((start, n - quiet))
    runs = [(s * FRAME, e * FRAME) for s, e in runs if (e - s) * FRAME >= MIN_CLIP]

    dur = len(audio) / RATE
    bounds = []
    for i, (s, e) in enumerate(runs):
        s, e = s - PAD_START, e + PAD_END
        # 여유를 붙여도 옆 대사와 겹치지 않게 사이 무음의 가운데에서 멈춘다
        if i > 0:
            s = max(s, (runs[i - 1][1] + runs[i][0]) / 2)
        if i < len(runs) - 1:
            e = min(e, (runs[i][1] + runs[i + 1][0]) / 2)
        bounds.append((max(0.0, s), min(dur, e)))
    return bounds


def transcribe_clip(model, clip16k):
    segs, _ = model.transcribe(clip16k, language='ko', beam_size=5, vad_filter=False,
                               condition_on_previous_text=False)
    return ' '.join(s.text.strip() for s in segs).strip()


def split_file(model, src, out_dir):
    audio = read_audio(src)
    audio16 = read_audio(src, ASR_RATE)
    bounds = find_speech(audio)
    if not bounds:
        print('  소리가 있는 구간을 찾지 못했습니다.')
        return 0
    out_dir.mkdir(parents=True, exist_ok=True)
    for n, (s, e) in enumerate(bounds, 1):
        name = f'{src.stem}_{n:03d}'
        text = transcribe_clip(model, audio16[int(s * ASR_RATE):int(e * ASR_RATE)])
        write_mp3(out_dir / f'{name}.mp3', audio[int(s * RATE):int(e * RATE)])
        (out_dir / f'{name}.txt').write_text(text + '\n', encoding='utf-8')
        print(f'  {name}  [{s:6.1f}s ~ {e:6.1f}s]  {text or "(인식된 말 없음)"}')
    return len(bounds)


def main():
    SPLIT_DIR.mkdir(exist_ok=True)
    todo = [(d, f) for d in sorted(SPLIT_DIR.iterdir()) if d.is_dir()
            for f in sorted(d.iterdir()) if f.is_file() and f.suffix.lower() in AUDIO_EXT]
    if not todo:
        print('자를 파일이 없습니다. 자르기\\<캐릭터 이름>\\ 폴더에 보이스 모음 파일을 넣으세요.')
        return
    print(f'자를 파일 {len(todo)}개. 모델을 불러오는 중…')
    add_cuda_dlls()
    try:
        model = load('cuda')
    except Exception as e:
        print(f'GPU를 쓸 수 없어 CPU로 진행합니다 (느림): {e}')
        model = load('cpu')

    for char_dir, src in todo:
        out_dir = CHAR_DIR / char_dir.name
        print(f'\n[{char_dir.name}] {src.name}')
        if any(out_dir.glob(f'{src.stem}_[0-9][0-9][0-9].mp3')):
            print(f'  건너뜀: 캐릭터\\{char_dir.name}\\ 에 이미 {src.stem}_001 같은 파일이 있습니다. 원본 이름을 바꿔서 다시 넣으세요.')
            continue
        n = split_file(model, src, out_dir)
        done = char_dir / DONE_NAME
        done.mkdir(exist_ok=True)
        shutil.move(str(src), str(done / src.name))
        print(f'  → 대사 {n}개로 잘랐습니다. 원본은 {DONE_NAME} 폴더로 옮겼습니다.')
    print('\n끝. 잘린 대사는 한 번 들어보고, 이상한 파일은 지우거나 txt를 고치세요.')


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        sys.exit('\n중단했습니다.')
