# WER/CER measurement for FARMER-AI-PHONE ASR (2026-11-12).
# Purpose: turn decoded CTC token ids into text and compute WER/CER against
# reference transcripts. NO QUALITY CLAIM is valid without references for
# every fixture used. This script never edits the model; it only scores it.
#
# Token text mapping uses the approved model's vocab.json (id -> token piece).
# Decode rule matches the runtime probe: CTC collapse (drop blanks id=408
# and consecutive repeats).
#
# Usage:
#   python tools/asr_wer_cer.py --fixtures am-12 --refs refs.json --out report.json
# refs.json format:
#   {"am-12": "የመልእክት ጽሑፍ ...", "om-218": "..."}
# Prediction sources (one of):
#   --argmax argmax-ort-fp32-am-12.txt        (raw ids, decoded here)
#   --text pred-am-12.txt                     (already decoded text)
import argparse
import json
import unicodedata
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
HF_MODEL = REPO / "app/models/badrex--Ethio-ASR-multilingual-600M"
BLANK_ID = 408

def load_vocab():
    vocab = json.loads((HF_MODEL / "vocab.json").read_text(encoding="utf-8"))
    id_to_piece = {}
    for piece, idx in vocab.items():
        id_to_piece[idx] = piece
    return id_to_piece

def ctc_collapse(ids):
    out, prev = [], BLANK_ID
    for i in ids:
        if i == BLANK_ID:
            prev = BLANK_ID
            continue
        if i != prev:
            out.append(i)
        prev = i
    return out

def ids_to_text(ids, id_to_piece):
    # Vocab style: '|' is the word separator; '[AMH]'/'[ORM]' are language tags.
    pieces = [id_to_piece.get(i, "") for i in ids]
    text = "".join(pieces)
    text = text.replace("<pad>", "").replace("<s>", "").replace("</s>", "")
    text = text.replace("|", " ")
    for tag in ("[AMH]", "[ORM]"):
        if text.startswith(tag):
            text = text[len(tag):]
    return text.strip()

def normalize(text):
    # Keep script characters; normalize punctuation/spacing only.
    text = unicodedata.normalize("NFC", text)
    return " ".join(text.split())

def wer(reference, hypothesis):
    r, h = reference.split(), hypothesis.split()
    d = [[0] * (len(h) + 1) for _ in range(len(r) + 1)]
    for i in range(len(r) + 1): d[i][0] = i
    for j in range(len(h) + 1): d[0][j] = j
    for i in range(1, len(r) + 1):
        for j in range(1, len(h) + 1):
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1,
                          d[i - 1][j - 1] + (r[i - 1] != h[j - 1]))
    return d[len(r)][len(h)], len(r)

def cer(reference, hypothesis):
    r, h = list(reference), list(hypothesis)
    d = [[0] * (len(h) + 1) for _ in range(len(r) + 1)]
    for i in range(len(r) + 1): d[i][0] = i
    for j in range(len(h) + 1): d[0][j] = j
    for i in range(1, len(r) + 1):
        for j in range(1, len(h) + 1):
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1,
                          d[i - 1][j - 1] + (r[i - 1] != h[j - 1]))
    return d[len(r)][len(h)], len(r)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixtures", nargs="+", required=True)
    ap.add_argument("--refs", required=True)
    ap.add_argument("--argmax-dir", default=".")
    ap.add_argument("--out", default="wer-cer-report.json")
    args = ap.parse_args()

    refs = json.loads(Path(args.refs).read_text(encoding="utf-8"))
    id_to_piece = load_vocab()
    rows = []
    for fixture in args.fixtures:
        if fixture not in refs:
            rows.append(dict(fixture=fixture, status="MISSING_REFERENCE"))
            continue
        path = Path(args.argmax_dir) / f"argmax-ort-fp32-{fixture}.txt"
        ids = [int(x) for x in path.read_text(encoding="utf-8").split()]
        hyp = normalize(ids_to_text(ctc_collapse(ids), id_to_piece))
        ref = normalize(refs[fixture])
        w_err, w_len = wer(ref, hyp)
        c_err, c_len = cer(ref, hyp)
        rows.append(dict(fixture=fixture, status="SCORED",
                         hypothesis=hyp, reference=ref,
                         wer=round(w_err / w_len, 4), wordCount=w_len,
                         cer=round(c_err / c_len, 4), charCount=c_len))
    report = dict(tool="asr_wer_cer", blankId=BLANK_ID, rows=rows)
    Path(args.out).write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=False))

if __name__ == "__main__":
    main()
