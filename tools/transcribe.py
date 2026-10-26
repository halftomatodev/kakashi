"""캐릭터 폴더의 mp3마다 같은 이름의 txt 전사를 만든다. 이미 txt가 있으면 건너뛴다."""
import importlib.util
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHAR_DIR = ROOT / '캐릭터'
MODEL = 'large-v3'


def add_cuda_dlls():
    # pip로 받은 cuBLAS / cuDNN DLL을 찾을 수 있게 경로에 추가한다 (Windows)
    for pkg in ('nvidia.cublas', 'nvidia.cudnn'):
        try:
            spec = importlib.util.find_spec(pkg)
        except ModuleNotFoundError:
            continue
        if not spec or not spec.submodule_search_locations:
            continue
        for p in spec.submodule_search_locations:
            b = os.path.join(p, 'bin')
            if os.path.isdir(b):
                os.add_dll_directory(b)
                os.environ['PATH'] = b + os.pathsep + os.environ['PATH']


def load(device):
    from faster_whisper import WhisperModel
    if device == 'cuda':
        return WhisperModel(MODEL, device='cuda', compute_type='float16')
    return WhisperModel(MODEL, device='cpu', compute_type='int8')


def transcribe(model, path):
    def run(vad):
        segs, _ = model.transcribe(str(path), language='ko', beam_size=5, vad_filter=vad)
        return ' '.join(s.text.strip() for s in segs).strip()
    # 배경음 때문에 VAD가 목소리까지 잘라 버리면 VAD 없이 다시 시도
    return run(True) or run(False)


def main():
    if not CHAR_DIR.is_dir():
        print(f'캐릭터 폴더가 없습니다: {CHAR_DIR}')
        return
    todo = sorted(p for p in CHAR_DIR.rglob('*')
                  if p.suffix.lower() == '.mp3' and not p.with_suffix('.txt').exists())
    if not todo:
        print('새로 전사할 mp3가 없습니다.')
        return
    print(f'전사할 파일 {len(todo)}개. 모델을 불러오는 중… (처음에는 약 3GB를 내려받습니다)')

    add_cuda_dlls()
    device = 'cuda'
    try:
        model = load(device)
    except Exception as e:
        print(f'GPU를 쓸 수 없어 CPU로 진행합니다 (느림): {e}')
        device = 'cpu'
        model = load(device)

    done = 0
    for i, path in enumerate(todo, 1):
        rel = path.relative_to(CHAR_DIR)
        try:
            text = transcribe(model, path)
        except Exception as e:
            gpu_error = any(k in str(e).lower() for k in ('cuda', 'cublas', 'cudnn', '.dll'))
            if device != 'cuda' or not gpu_error:
                print(f'[{i}/{len(todo)}] 실패: {rel} ({e})')
                continue
            print(f'GPU 오류로 CPU로 전환합니다: {e}')
            device = 'cpu'
            model = load(device)
            text = transcribe(model, path)
        path.with_suffix('.txt').write_text(text + '\n', encoding='utf-8')
        done += 1
        print(f'[{i}/{len(todo)}] {rel}  →  {text or "(인식된 말 없음)"}')
    print(f'\n완료: {done}개 전사 ({device.upper()})')


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        sys.exit('\n중단했습니다. 다시 실행하면 남은 파일부터 이어서 합니다.')
